# WeChat Block Streaming 优化：智能边界 + 图片拆出

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `WeixinStreamer` 的分块策略从"按 char 数硬切"升级为"按语义边界优先 + 图片拆出单独发送 + 代码块不拆"，让用户在微信端的流式体验更接近自然分段。

**Architecture:** 在 `WeixinStreamer` 内部新增一个边界感知的累积/发射循环：累积 delta 时实时扫描 `pendingText`，识别完整的 `![alt](url)` 图片模式并把图片抽离为待发射队列；触发 flush 时按"图片位置 + 文本边界"分段，按源序发射 `text bubble` 和 `image message`。

**Tech Stack:** TypeScript / Vitest / `@tencent-weixin/openclaw-weixin@2.4.3` / Node.js setTimeout + queueMicrotask

---

## 背景与现状

`feat/weixin-block` PR (#375) 已落地 `WeixinStreamer`，当前行为：
- 每条 SSE delta → 直接 append 到 `pendingText`
- `pendingText.length >= minChars` 时 flush（默认 200 字符）
- 第一条到达后空闲 3000ms 也 flush（仅首次）
- 失败 3 次升级为 `Error`，终止流
- 收尾用 `(回复未完成)` 后缀一次性发出

三个痛点：
1. **分块只看字符数**：可能在 `Hello world, thi|s is great.` 中间切（半个词）。
2. **代码块会被切碎**：模型输出 ` ```js\nconst a = 1\n``` ` 时，围栏正好跨过 200 字符阈值就被切。
3. **图片 markdown 被 `StreamingMarkdownFilter` 直接 strip 掉**，用户看不到任何图片信息。

## 设计目标

1. **块大小合适**：默认 200 ~ 1500 字符区间，超过则视为异常并强制断（兜底）
2. **不切碎语义单元**：永远不在 ` ``` ... ``` ` 围栏内切；不在英文/中文单词中间切
3. **图片可见**：完整识别 `![alt](url)` 后调 `sendImageMessageWeixin` 单独发，与文本气泡交错
4. **顺序保留**：文本在前 → 图片 → 文本在后，按源序发送
5. **向后兼容**：默认行为对 `weixinStream=false` 通道、`feishuStream` 等其他流程零影响

## 设计

### 优先级（从高到低）

| 优先级 | 边界类型 | 匹配正则 | 示例 |
|---|---|---|---|
| 1 | 段落 | `\n\n` | `Hello\n\nWorld` 在 `\n\n` 后断 |
| 2 | 中英句子 | `[。！？.!?]\s` | `Hello. World` 在 `. ` 后断 |
| 3 | 逗号分号 | `[,;,，；]\s` | `Hello, world` 在 `, ` 后断 |
| 4 (兜底) | maxChars 硬断 | — | `Hello[1500 chars]world` 在 1500 处切 |

中文标点 `。！？，；` 都是全角，不与 ASCII 标点冲突。

### 代码围栏感知

累积期间维护一个"是否在代码围栏内"状态机：
- 看到奇数次 ` ``` `（行首或独占行）→ 进入围栏
- 看到偶数次 ` ``` ` → 离开围栏

`findFlushBoundary(segment, minChars)` 在回扫边界候选时，过滤掉围栏内的候选：
1. 在 segment 上扫描所有 `\n\n`、`.!?。！？` 后跟空白、`,;,，；` 后跟空白的位置
2. 标记每个候选位置是否处于围栏内
3. 从 minChars 位置向 segment 末端回扫，取**第一个围栏外**的候选

如果 segment 中所有候选都在围栏内，函数返回 -1（不切），等下次。
如果 segment.length > maxChars 且仍无围栏外候选 → 在 maxChars 处硬切（即便在围栏内）。

### 图片抽出发射

累积期间用一个简单正则扫描完整图片：
```
/!\[[^\]]*\]\((?:https?:|\/)[^\s)]+\)/g
```

匹配从 `![` 开始到 `)` 结束的完整图片 markdown（不含空格在 URL 中，含 http(s)/绝对路径）。

`pendingText` 仍然保留原文（不去掉图片占位），因为发射时需要位置信息。

### 发射循环（flush 时）

```python
def flushTick(force=False):
  processed = True
  while processed:
    processed = False
    imageMatch = findCompleteImage(pendingText)

    if imageMatch is None:
      # No more images: try to flush text
      boundary = findFlushBoundary(pendingText, minChars)
      if boundary > 0:
        emitText(pendingText[0:boundary])
        pendingText = pendingText[boundary:]
        processed = True
      elif pendingText.length > maxChars:
        # No clean boundary, hard split at maxChars
        emitText(pendingText[0:maxChars])
        pendingText = pendingText[maxChars:]
        processed = True
      elif force:
        # turn_completed: emit whatever is left
        if pendingText:
          emitText(pendingText)
          pendingText = ''
      # else: wait for more deltas
      break

    # Image found at [imageStart, imageEnd]
    imageStart, imageEnd = imageMatch
    if imageStart > 0:
      textBefore = pendingText[0:imageStart]
      boundary = findFlushBoundary(textBefore, minChars)
      if boundary > 0:
        emitText(textBefore[0:boundary])
        pendingText = textBefore[boundary:] + pendingText[imageStart:]
        processed = True
        continue
      elif textBefore.length > maxChars:
        emitText(textBefore[0:maxChars])
        pendingText = textBefore[maxChars:] + pendingText[imageStart:]
        processed = True
        continue
      elif force:
        # turn_completed with short text before image
        emitText(textBefore)
        pendingText = pendingText[imageStart:]
        processed = True
        continue
      else:
        # textBefore too short to flush, wait for more deltas
        break

    # Image at start of pendingText (or textBefore fully handled above)
    emitImage(pendingText[imageStart:imageEnd])
    pendingText = pendingText[imageEnd:]
    processed = True
```

触发时机：
- `minChars` 到达（idle 或字符数）：调用 `flushTick(force=false)`
- `turn_completed` / `turn_failed` / `turn_aborted`：调用 `flushTick(force=true)` 把残留全部发完

### BridgeHandle 扩展

新增一个方法：

```ts
type BridgeHandle = {
  sendMessage: (accountId, to, text, contextToken?) => Promise<{ messageId: string }>
  sendImage: (accountId, to, imageUrl, contextToken?) => Promise<{ messageId: string }>
}
```

`BridgeHandle` 在 `weixin-streamer.ts` 里是局部类型，由 `ClawRuntime` 通过 `subscribeSseForWeixin` 注入。需要同步更新：

1. `src/main/claw-runtime.ts` 中 `WeixinBridgeHandle` 类型加 `sendImage`
2. `src/main/weixin-bridge-runtime.ts` 中 `weixinBridgeRuntimeInternals` 暴露的 `sendMessageWeixin` 旁边新增 `sendImageWeixin`，调用 `sendImageMessageWeixin`（已存在于 SDK v2.4.3 `dist/src/messaging/send.js:116`）
3. `src/main/index.ts` 中注入 `weixinBridge` 时把 `sendImage` 一起带上

### 新增参数与默认值

```ts
WeixinStreamer 构造新增：
- maxChars: number  // 默认 1500
```

`runStreamingReplyWeixin` 新增参数透传：

```ts
{
  ...
  maxChars?: number  // 默认 1500
}
```

`ClawRuntime` 暂时硬编码默认值，后续如需要可走 settings。

### 不在本期范围

- ❌ typing 指示器（`sendtyping`）：SDK 支持但 GUI bridge 没接，独立 PR
- ❌ `MessageState.GENERATING` 标记：语义上和 block 流式重叠
- ❌ Markdown 链接 / 表格 / 标题 的特殊处理：纯文本保留
- ❌ 图片标题 `![alt](url "title")` 的解析：暂不支持，只识别无标题版本

## 测试

新增/更新 `src/main/weixin-streamer.test.ts`：

| 测试 | 验证点 |
|---|---|
| splits at paragraph boundary `\n\n` first | 优先级 1 |
| falls back to sentence boundary when no paragraph | 优先级 2 |
| falls back to comma boundary when no sentence | 优先级 3 |
| hard-splits at maxChars when no boundary found | 兜底 |
| never splits inside code fence | 围栏保护 |
| waits for code fence to close before splitting | 围栏状态机 |
| extracts complete image and emits image+text in order | 图片基本路径 |
| skips incomplete image markdown and keeps it in pendingText | 图片跨 delta |
| emits multiple images interleaved with text | 多图片交错 |
| handles image send failure as consecutive failure | 图片失败计入 |
| flushes remaining text + images at turn_completed | 收尾 |
| does not re-emit already-flushed images | 状态保持 |

新增 `src/main/weixin-bridge-runtime.test.ts`：

| 测试 | 验证点 |
|---|---|
| `sendImageWeixin` calls `sendImageMessageWeixin` with correct payload | SDK 桥接 |

更新 `src/main/claw-runtime.test.ts`：

| 测试 | 验证点 |
|---|---|
| passes `sendImage` to `runStreamingReplyWeixin` | 注入路径 |
| `BridgeHandle` type includes `sendImage` | 类型 |

## 兼容性

- `WeixinStreamer` 构造函数新增 `maxChars?` 可选参数，老调用方不传则用默认值
- `BridgeHandle` 在 `weixin-streamer.ts` 内是局部类型，但通过 `ClawRuntimeDeps.weixinBridge` 注入，需要同步更新注入点的类型定义
- `runStreamingReplyWeixin` 不传 `maxChars` 则用默认值
- 不修改 `weixin-bridge-runtime.ts` 的 `sendWeixinBridgeMessage` 对外签名
- 不修改 `package.json`（`@tencent-weixin/openclaw-weixin@2.4.3` 已在 develop）
- 不修改 i18n key、UI toggle

## 风险与权衡

1. **图片跨 delta 解析复杂度**：正则 + 状态机要稳健，建议用单元测试覆盖 `![alt](url` 不完整、`![alt](url "title")` 干扰等异常
2. **maxChars 兜底可能在单词中间切**：用户已选"接受"，但视觉上偶尔出现半个词。文档化。
3. **`sendImage` 失败计入 consecutiveFailures**：与文本失败同等对待。如果微信 iLink 经常临时拒图（比如频率限制），可能误升级为流失败。可后续加白名单（图片失败仅降级不升级）
4. **顺序发送**：图片与文本用串行 `await` 保证顺序，吞吐会下降。对于一般回复可接受
5. **新增 BridgeHandle.sendImage 字段是必需字段**：老注入点（如果有的话）需要补上。否则类型报错