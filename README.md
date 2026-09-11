# 高晟哲 · Jimmy Gao 个人作品集

线上访问：[jiostrider.github.io/gaoshengzhe](https://jiostrider.github.io/gaoshengzhe/)

这是一个高保真单页个人作品集，用于展示 AI 应用、交互网页项目、学习经历、认证与联系方式。页面采用深色动态背景、液态玻璃视觉和原生交互实现。

## 技术栈

- 原生 HTML、CSS、JavaScript
- 无构建步骤、无前端框架依赖
- GitHub Pages 静态部署

## 本地预览

直接使用浏览器打开 `index.html` 即可预览。

如需更接近线上环境，也可以在项目目录启动任意静态文件服务器后访问首页。

## 目录说明

```text
├─ index.html          页面结构与资源入口
├─ css/styles.css      全部视觉样式与响应式布局
├─ js/main.js          页面交互、动画与内容数据
├─ src/assets/         图片、视频、音频等媒体资源
└─ public/resume.pdf   可下载的 PDF 简历
```

## 主要功能

- 移动端导航与响应式布局
- 动态背景视频与默认开启的背景音乐
- AI 实战项目扑克牌轮播
- 演示文稿轮播与全屏查看
- 可拖拽的荣誉证书墙
- 联系资料、二维码与 PDF 简历下载
- 本地规则型作品集导览助手

## 更新与部署

项目推送到 `main` 分支后，由 GitHub Pages 发布。

样式与脚本使用版本参数避免浏览器缓存旧文件：

```html
<link rel="stylesheet" href="./css/styles.css?v=20260911.1" />
<script src="./js/main.js?v=20260911.1" defer></script>
```

修改 CSS 或 JavaScript 并部署时，请同步更新这两个 `v=` 版本号。

## 关于真实 AI 接入

当前站内助手使用本地规则回答，不需要密钥。若后续接入 OpenAI API，需要通过 Cloudflare Worker、Netlify Function 或 Vercel Function 等服务端接口调用。

不要将 `OPENAI_API_KEY` 写入 `index.html`、`main.js`、仓库提交记录或任何公开配置文件。
