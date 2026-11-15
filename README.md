# 插图标记自动配图 · illust-marker

> 让 AI 在回复里"点播"插图：正文写一个标记，扩展自动出图并插在那一句下面。
> 兼容 **SillyTavern**、**TauriTavern** 以及任何支持标准前端扩展的 SillyTavern 衍生前端。

```text
她推开门，雪从屋檐上落下来。
[ILLUST: 雪夜中的少女回眸 | 1girl, snow, night, looking back, [ke-ta], cinematic lighting]
```

---

## 特点

- **生图后端可插拔** —— 中转站直连 / 本地 A1111 / 酒馆自带「图像生成」，设置里一键切换。默认走中转站，**不依赖任何本机服务，装完填个地址和 Key 就能用**。
- **为 TauriTavern 准备了退路** —— TauriTavern 的 `/api/*` 由前端拦截器接管，未实现的端点返回 404。默认的中转站直连完全绕过 `/api`，因此不受影响。
- **单文件构建** —— 扩展以一份内联 bundle 交付。原因见[为什么是单文件](#为什么是单文件)。
- **NovelAI 语法兼容** —— 直接从 NovelAI 抄来的 `0.6::tag::`、`[tag]`、`{tag}` 会按需转换。
- **空白图自动重试** —— 中转站上游失败时经常返回「HTTP 200 + 纯黑占位图」，扩展会识别并重试，而不是把黑图当成成功。
- **手机优先** —— 触控目标 ≥40px，安全区适配，悬浮球长按拖动。
- **零依赖** —— 没有构建期 npm 依赖，没有后端插件，不碰数据库。

## 安装

### SillyTavern

```bash
cd <SillyTavern>/data/default-user/extensions
git clone <本仓库地址> illust-marker
```

或者把仓库内容直接复制到 `data/default-user/extensions/illust-marker/`，然后刷新酒馆页面。

> ⚠️ 安装位置是 `data/<user>/extensions/illust-marker/`，**不要**放进 `extensions/third-party/`，
> 也不要放进 `public/scripts/extensions/`。前者在酒馆里不会被扫描到，后者是系统目录、升级会丢。

### TauriTavern

TauriTavern 内置原生 Git。在「扩展」面板里用仓库地址安装，或把目录放到同样的相对位置后重启应用。

## 配置（最少两步）

1. 打开 **扩展 → 插图标记自动配图**。
2. 生图后端选 **中转站直连**，填：

| 字段 | 说明 |
|---|---|
| 中转站地址 | 形如 `https://example.com/v1`（不带 `/images/generations`） |
| API Key | 中转站给的令牌 |
| 模型 | 可留空；点「拉取模型列表」可以直接选 |

点 **测试连接** 确认能出图，然后就可以用了。

想改用本机 WebUI？后端切到「本地 A1111 / 适配器」，地址填 `http://127.0.0.1:7860`。
想沿用酒馆自己的图像生成配置？后端切到「酒馆「图像生成」后端」——但 **TauriTavern 下请勿选它**，那条路径依赖 `/api/sd/*`。

## 标记格式

```
[ILLUST: 自然语言描述 | danbooru,tag,list]
```

- 竖线**前**：自然语言描述，默认只当备注、不进提示词。
- 竖线**后**：英文 Danbooru 标签，**默认只用这段**（illustrious 类模型吃标签）。
- 标签里可以有方括号，比如 `[ke-ta]`、`[modare]` —— 解析按括号层级配对，不会把标记截断。

## 提示词预处理

| 选项 | `0.6::mignon, artist:x::, [ke-ta], {smile}` 的结果 |
|---|---|
| **去掉 NovelAI 语法**（默认） | `mignon, artist:x, ke-ta, smile` |
| 转成 A1111 权重 | `(mignon, artist:x:0.6), (ke-ta:0.9), (smile:1.05)` |
| 原样发送 | 不处理 |

已经有 A1111 含义的写法会被保留：`[a|b]`（交替）、`[from:to:0.5]`（阶段切换）、`(tag:1.2)`。

## 交互

| 功能 | 说明 |
|---|---|
| 生成中 | 消息里显示「正在绘制插图…」占位，不弹浮窗 |
| 完成提示 | 底部绿条「✅ 插图已完成」，1 秒后自动消失；后台时标签标题会闪 |
| 悬浮球 | 右下角 🖼：点一下跳到**最新生成的那张**，再点一下回到原阅读位置（图标变 ↩）。长按 0.3 秒可拖动，位置会记住 |
| 未读气泡 | 有新图时右上角红色数字徽标并脉动 |
| 看大图 | 页内全屏，支持滚轮/双指缩放、双击切换、拖动，Esc 关闭 |
| 重新生成 | 大图内「🔄 重新生成」；「📝 提示词」可改完再重画 |
| 历史 | 设置里的「🖼 查看本聊天插图历史」：单张删除、或「选择」后批量删除 |

## 调试入口（浏览器控制台）

```js
__illustHistory()       // 打开本聊天插图历史
__illustDecorateAll()   // 重扫并重绘当前所有消息
__illustJump()          // 跳到最新插图
__illustSettings()      // 查看当前生效的设置
__illustCapabilities()  // 查看宿主能力探测结果
```

## 开发

仓库结构：

```text
index.js          # 入口：事件绑定、DOM 装饰、灯箱、历史面板、设置面板
lib/
  host.js         # 宿主适配层（能力探测 / 设置 / 聊天 / 事件 / 落盘）
  settings.js     # 设置归一化、默认值、旧版迁移
  prompt.js       # 提示词预处理 + 标记解析
  blank.js        # 空白（全黑）图检测
  providers/
    index.js      # provider 注册表 + fetch 封装 + 错误归一
    relay.js      # 中转站直连
    a1111.js      # A1111 / Forge / SD.Next
    tavern.js     # 酒馆自带「图像生成」后端
build.mjs         # 把 lib/ + index.js 打成 dist/index.js
test/             # 契约测试（含 mock 中转站）
dist/index.js     # 构建产物，扩展实际加载的文件
```

```bash
node build.mjs . dist/index.js   # 构建
node test/run.mjs                # 测试（36 项，不需要浏览器）
```

改完源码记得重新 build —— `manifest.json` 指向 `dist/index.js`。

### 为什么是单文件

SillyTavern 的扩展静态端点 `/scripts/extensions/<name>/*` 行为是：

- 根目录下的 ESM 正常加载；
- **子目录里的模块会 404**（`/scripts/extensions/<name>/lib/x.js`）。

更麻烦的是加载器由 `script.onload` 驱动：入口模块一旦因为子模块 404 而失败，`onload` 不触发，
加载器的 promise 永不落地，**排在后面的所有扩展都不会启动**。

所以构建时把全部模块内联成一份 `dist/index.js`，入口自己用相对路径导入也一并去掉。
`build.mjs` 会在构建期拦下两类会炸掉单文件的东西：

1. 跨模块同名顶层声明；
2. `import * as ns from '...'`（命名空间导入会被删掉，留下未定义引用）。

### 新增一个生图后端

实现一个对象并通过 `registerBuiltinProviders` 注册即可：

```js
const myProvider = {
    id: 'my-backend',
    label: '我的后端',
    async generate(settings, request) {
        // request: { prompt, negativePrompt, width, height, steps, cfgScale, seed, batchSize, model }
        return ['<base64 without data: prefix>'];
    },
};
```

然后在 `lib/settings.js` 的 `BACKENDS`、设置面板的下拉、`index.js` 的注册调用里各加一处。
出错请抛 `IllustError`，message 是给用户看的中文短句。

## 兼容性说明

| 宿主 | 状态 | 备注 |
|---|---|---|
| SillyTavern 1.12+ | ✅ 已验证 | `extension_settings` 是模块导出，不是全局变量 —— 由 `lib/host.js` 动态解析 |
| TauriTavern | ✅ 按契约适配 | 默认后端绕过 `/api/*`；设置直接写 `extension_settings`；样式不含 `@layer`，不触发降级路径 |
| 其他衍生前端 | ⚠️ 尽力而为 | 能力缺失会逐项降级：没有事件总线就用 MutationObserver；不能写盘就把图存成 data URL |

已知限制：

- 没有 `saveBase64AsFile` 的宿主上，图片以 data URL 内联进聊天记录，**体积会很大**，设置面板会提示。
- 自动模式只对**最新一条**回复触发出图，历史消息显示「🎨 绘制此段插图」按钮。
- 中转站普遍只接受每次 1 张，「每次出图张数」>1 时会串行请求。

## 许可

MIT，见 [LICENSE](LICENSE)。
