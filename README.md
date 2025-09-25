# Bin Checker (Node CLI)

一个用于请求 `https://lingchenxi.top/Bincheck/banklist.php?bin=<BIN>` 的命令行工具。

## 安装与使用

1. 安装依赖（本工具零依赖，可跳过）。
2. 直接运行：

```bash
npm run bincheck
# 或
node src/index.js 520581
# 或
BIN=520581 node src/index.js
```

## 命令

- 传入参数：`bincheck <bin>`
- 环境变量：设置 `BIN` 后直接运行 `node src/index.js`

## 返回值
- OneBot WS 客户端：

### OneBot 配置与运行

1. 编辑 `src/onebot.js` 顶部，设置：
   - `WS_URL`：你的 OneBot 正向 WebSocket 地址（如 `ws://127.0.0.1:6700`）
   - `ACCESS_TOKEN`：若启用了 access_token，请填写；否则留空
2. 启动：

```bash
npm run onebot
```

3. 在你绑定的 QQ（或兼容 OneBot 平台）中，私聊或群聊发送：

```
bin 520581
```

机器人将自动查询并回复接口返回数据（JSON 或字符串）。


- 成功：打印 JSON 或原始字符串
- 失败：打印错误信息并以非零码退出


