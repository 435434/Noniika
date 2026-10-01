# 第三方组件与许可声明（THIRD-PARTY NOTICES）

> 本文件跟随分发产物一起提供。任何再分发都必须原样保留本文件。
> 生成时间：2026-09-28 ｜ 对应版本：v1.0.0
>
> 本插件本体按 **免费使用许可 v1.0** 发放（见同目录 `LICENSE`）：免费、功能完整、
> 赞助完全自愿。本文件管的是"包里带着别人的东西"该怎么合规，两者互不影响。

---

## 一、分发包里**实际包含**的第三方组件

这些是本插件分发产物里真正带着别人的东西，每条都有对应义务，**必须保留**。

| 组件 | 版本 | 许可 | 位置 | 我们的义务 |
|---|---|---|---|---|
| **FFmpeg** | N-126856（2026-09-25 构建） | **LGPL-3.0**（该构建**未**启用 `--enable-gpl`） | `pipeline/vendor/ffmpeg/ffmpeg.exe` | ①随包附许可全文（已放 `pipeline/vendor/ffmpeg/LICENSE.txt`）②提供源码获取途径（见下方链接）③**以独立进程调用**，不与本项目源码链接 |
| **Node.js 运行时** | 见 `node-runtime/说明.txt` | **MIT**（内含 V8/OpenSSL/ICU/zlib/libuv 等，各按其自身许可） | `node-runtime/node.exe` | **随包附官方完整 `LICENSE`**（`node-runtime/LICENSE`，约 144 KB）—— 见下第二节 |
| **拼音数据表** | 生成于 2026 | **MIT**（数据源 `pinyin-pro`） | `cep/js/pinyin-table.js`（由 `tools/make-pinyin-table.js` 生成） | `pinyin-pro` **仅在生成期使用、不进分发包**；本表为派生数据，标注出处即可（见下第二节） |

### FFmpeg 的源码获取途径（LGPL-3.0 要求）

- FFmpeg 官方源码：<https://ffmpeg.org/download.html>
- 本包所用构建的来源与构建脚本：<https://github.com/BtbN/FFmpeg-Builds>
- 本包用的是该项目的 `ffmpeg-master-latest-win64-lgpl` 变体（**不含 GPL-only 组件**）

> ⚠ **不要**把这里的 ffmpeg 换成 GPL 构建（`--enable-gpl`）。
> 换之前先确认，并同步更新本文件与包里附带的许可全文。
> 判断方法：`ffmpeg -version`，看 `configuration:` 里有没有 `--enable-gpl`。

---

## 二、随附的许可全文

### Node.js —— MIT（＋内嵌组件的许可清单）

**完整许可已随包附在 `node-runtime/LICENSE`（约 144 KB / 2700 余行）。**

为什么不能只写一句"Node.js 是 MIT"就完事：MIT 许可明确要求
「在软件的**所有副本**中附上版权声明与许可声明」。随包分发 `node.exe` 就是分发它的副本，
所以必须附。而且官方那份 `LICENSE` 不只是 MIT 一段 —— 它还逐条列出了 `node.exe` 里
**内嵌的 V8、OpenSSL、ICU、zlib、libuv、npm 等组件各自的许可**
（OpenSSL 另有"必须提及"的附加要求）。因此附**完整版**，而不是节选。

开头这段是 Node.js 本体：

```
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

其余（V8 / OpenSSL / ICU / zlib / libuv 等）的清单见随包的 `node-runtime/LICENSE`，
或 Node.js 源码树中的同一文件：<https://github.com/nodejs/node/blob/main/LICENSE>

> ⚠ **不要**删掉 `node-runtime/LICENSE`。它是 node.exe 能合法随包分发的前提。

### pinyin-pro —— MIT License

```
Copyright (c) 2020-present zh-lx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 三、**不随包分发**、由用户机器按需获取的组件

下面这些**刻意不打包**。这是既省体积、又避开许可义务的做法，**请勿改成预打包**。

| 组件 | 许可 | 为什么不分发 | 用户如何获得 |
|---|---|---|---|
| **audio-separator** | MIT | 体积大（含整个 Python 依赖树） | 面板「人声分离 → 一键安装环境」，用 pip 装到用户自己的数据目录 |
| **Python 依赖树**（torch / torchvision / numpy / scipy / scikit-learn / soundfile / pydub / sympy / tqdm / **libsndfile**(LGPL-2.1) / soxr 等） | 多为 BSD/MIT；**libsndfile 为 LGPL-2.1** | 同上；且作为独立环境由用户自行安装 | 同上（pip 拉到用户机器） |
| **人声分离模型权重**（`Kim_Vocal_2.onnx`、`vocals_mel_band_roformer.ckpt`、Demucs 系列） | ⚠ **上游未给出明确的商用授权条款** | ①体积 934 MB ②**授权不明确，不应随商业产品分发** | 面板里按需下载（下载源见 `models/uvr/download_checks.json`） |

> ⚠ **模型权重这一条要特别当心**：UVR 生态的软件本体多为 MIT，
> 但**模型权重普遍没有写明是否允许商用**。目前的"用户自行下载"策略是正确的，
> **不要把模型打进分发包**。若将来想预置模型，请先逐一向模型作者确认授权。

---

## 四、曾经包含、现已**移除**的组件（记录备查）

| 组件 | 原许可 | 为什么移除 |
|---|---|---|
| **jianying-subtitle** v0.2.3 | **GPL-3.0-only** | ①**强 copyleft**：它被 `import` 进同一进程，可主张构成衍生作品，会使整个插件必须按 GPL-3 授权并提供源码 —— 与商业闭源分发不兼容；②它是靠**逆向**第三方 App 私有接口实现的（伪造客户端请求体、自行签发上传授权），违反对方用户协议，商业风险不可控。v0.9.0 起改为调用各服务商**官方公开 API**，许可与法律风险一并消除 |

同时移除的还有它带来的传递依赖；现在 `pipeline` **没有任何运行时 npm 依赖**
（只用 Node 标准库 + 内置 `fetch`），分发包里因此**不含 `node_modules`**。

---

## 五、分发前自检清单

> 下面绝大多数条目 **`tools/build-package.py` 会自动核对**：
> 出厂前逐文件扫一遍，不合格就删掉产物、拒绝出厂（"6b. 出厂自检"）。人工只需看它有没有报错。

- [ ] `pipeline/vendor/ffmpeg/ffmpeg.exe` 仍是 **LGPL** 构建（`ffmpeg -version` 里没有 `--enable-gpl`）
- [ ] `support.html` 与 `assets/zanshang-code.png` 在包里（面板 ♥ 按钮打开的「支持作者」页；
      漏带的话对方点按钮会走兜底、把插件自带页面丢掉 —— 复制清单漏加过，已列入自检）
- [ ] `pipeline/vendor/ffmpeg/LICENSE.txt` 存在
- [ ] **`node-runtime/LICENSE` 存在**（Node.js 的 MIT 要求随副本附许可 —— 漏了就是合规缺口）
- [ ] 本文件与项目根 `LICENSE` 都进了分发目录
- [ ] 分发包里**没有** `node_modules`
- [ ] 分发包里**没有** `models/`、`python-env/`
- [ ] 分发包里**没有**任何**视频 / 音频素材**（尤其开发时的测试素材）
- [ ] 分发包里**没有**模型权重（`.onnx` / `.ckpt` 等）
- [ ] 分发包里**没有**字体文件（`.ttf` / `.otf` —— 授权各不相同，一律不打）
- [ ] 分发包里**没有** API 密钥 / SecretId / Token 之类的**字面量**
- [ ] 分发包里**没有** `.workbuddy/`（开发笔记与记忆）、`test/`、`design/`、`tools/`
- [ ] 界面与文档里没有以第三方商标（如"剪映""CapCut""字节跳动"）作为功能卖点

---

## 六、商标与关联声明

- 本软件是**独立的第三方工具**，与 **Adobe Inc. 无任何关联**，未获其赞助、认可或授权。
- 名称中的 **"AE" 指代 Adobe After Effects**，仅为说明本软件的**兼容对象**；
  "Adobe"、"After Effects" 是 Adobe Inc. 的商标或注册商标，本许可不授予任何商标使用权。
- 本软件调用的**语音识别服务**由用户**自行申请账号与密钥**，本软件与服务商之间
  不存在关联、赞助或合作关系（识别结果与服务质量由服务商负责）。
- 本文件提到的其它产品名称、公司名称与商标，均归其各自权利人所有，
  此处仅为**指称与说明**之用（nominative use）。

> 建议：对外宣传时**避免**出现"官方""合作""授权"这类字样，
> 也不要把第三方商标放进产品名或 logo —— 这是最容易被投诉的两点。
