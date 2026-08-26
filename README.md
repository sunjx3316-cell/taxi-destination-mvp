# 到哪儿 · 司机导航助手 MVP

这是一个可安装到 Android 手机的应用：司机创建一次性二维码，乘客扫码后粘贴地址，系统解析位置，司机一键跳转至自己的导航软件。

## 已实现

- 司机端创建 30 分钟有效的一次性会话与二维码。
- 乘客可扫码进入、手动输入会话码，或通过系统“粘贴”按钮输入详细地址。
- CloudBase 云函数使用高德 Web 服务地理编码，将文字地址转换为 GCJ-02 坐标；乘客选择候选项后才发送。
- CloudBase 文档型数据库保存 30 分钟有效的会话；司机端每 2 秒获取一次新目的地，可跳转高德、百度、腾讯和苹果地图。
- 没有地址解析结果时，乘客可以发送文字地址，但界面明确提示准确性会较低。
- 每个二维码只能成功提交一个目的地，防止后续扫码者篡改行程；应用不展示历史位置。

## CloudBase 部署（当前生产方案）

本项目已经指向现有 CloudBase 环境；以下操作应在 CloudBase 控制台或 CLI 中完成：

1. 部署 [destination-bridge](cloudbase/functions/destination-bridge/index.js) 云函数，工作目录是 `cloudbase`。
2. 为该函数新增环境变量 `AMAP_WEB_KEY`，值使用你的高德 **Web 服务** Key。这个值只留在云端，不能写入前端或 APK。
3. 给 `destination-bridge` 配置可被未登录访客调用的函数权限。函数内部仍用 30 分钟会话和司机私有 token 保护读取。
4. 将 `public` 目录部署到 CloudBase 静态托管，得到 HTTPS 访问地址。
5. 在 [runtime-config.js](public/runtime-config.js) 的 `DESTINATION_PUBLIC_WEB_URL` 填入该 HTTPS 地址。司机端生成的二维码会打开这个地址。
6. 执行 `npm run android:sync`，再在 Android Studio 中构建 APK。

CloudBase 会在首次创建会话时写入 `taxi_destination_sessions` 文档集合；数据库不需要向客户端开放读写权限。

## 本地备用模式

`server.js` 仍保留，便于不连云端时查看界面。把 `public/runtime-config.js` 的 `DESTINATION_CLOUDBASE_ENV` 暂时置空，配置 `.env` 后运行：

```powershell
npm start
```

## 生产化前必须补齐

- 安卓厂商推送、FCM/APNs，确保司机 App 在后台时仍能收到新目的地；当前版本要求司机 App 保持前台以轮询更新。
- 司机身份/车辆认证、风控限流与后台运营系统。
- 使用地图 POI 搜索/输入提示接口补强店名、地标等模糊目的地。
- 用户隐私协议、撤回/删除机制、频率限制与审计规则。

## 关于地图跳转

本项目用地图服务公开 URI 打开路线规划。所有跳转均需司机主动点击；不能、也不应模拟点击其他导航 App 的“开始导航”按钮。高德 URI 支持将起点留空（取司机当前位置）并把坐标作为终点。
