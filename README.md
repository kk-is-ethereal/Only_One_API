<div align="center">
  <h1>Only_One_API</h1>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p><strong>一个地址接入多个 API，按功能发放密钥，按优先级切换上游。</strong></p>
  <p>
    <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white">
    <img alt="SQLite" src="https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white">
    <img alt="Windows, macOS, Linux" src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-5543D8">
  </p>
</div>

[快速开始](#快速开始) · [接入-ai](#接入-ai) · [反代-http-服务](#反代-http-服务) · [多语言调用](#多语言调用) · [切换规则](#切换规则) · [部署与维护](#部署与维护) · [排障](#排障)

Only_One_API 是一个可自托管的 API 网关。用中文管理台录入兼容 OpenAI 的模型服务或通用 HTTP 服务，将它们排成主备队列，再为不同应用签发各自的 API Key。服务使用 Node.js 内置 SQLite，无需安装 npm 依赖。

```mermaid
flowchart LR
    Client["客户端 · API Key"] --> Gateway["Only_One_API"]
    Gateway --> Policy["路由组 · 功能授权"]
    Policy --> Primary["优先线路"]
    Primary -.->|符合切换条件| Backup["备用线路"]
```

## 快速开始

下载本仓库源代码或克隆后，在项目根目录打开终端。安装 **Node.js 24 或更新版本**，运行 `node --version` 确认版本。[Node.js 下载](https://nodejs.org/en/download)

| 平台 | 终端 | 启动命令 |
| --- | --- | --- |
| Windows | PowerShell 或 Windows Terminal | `node --env-file-if-exists=.env src/server.js` |
| macOS | Terminal，使用 zsh 或 bash | `node --env-file-if-exists=.env src/server.js` |
| Linux | bash 或兼容 Shell | `node --env-file-if-exists=.env src/server.js` |

1. 保持终端运行。首次启动时，终端会输出 `Admin password (shown once)`，请保存密码。
2. 浏览器打开 `http://127.0.0.1:8787`，使用管理员密码登录。
3. 在 **上游服务 → 路由组 → API Key** 依次配置。管理员密码用于登录管理台，签发的 Key 用于客户端访问 API。

`npm start` 提供同样的启动入口。如果 Windows 上 npm 脚本找不到 `node`，可直接使用表中的命令。按 `Ctrl+C` 停止服务。数据保存在项目下的 `data/`，后续启动会读取已有配置。

## 接入 AI

下面以 `chat-main` 为对外别名，把两个兼容 OpenAI Chat Completions 的上游组成主备队列。示例中的地址和实际模型 ID 请按上游文档替换。

### 1. 添加上游

在 **上游服务 → 新建上游** 选择 **OpenAI 兼容**。分别填写主线路和备用线路的配置。

| 字段 | 主线路示例 | 备用线路示例 |
| --- | --- | --- |
| 上游名称 | `主线路` | `备用线路` |
| 提供方 | `供应商 A` | `供应商 B` |
| Base URL | `https://primary.example/v1` | `https://backup.example/api/v1` |
| 默认模型 | `provider-a-model` | `provider-b-model` |
| 鉴权 Header / 前缀 | `Authorization` / `Bearer ` | 按该上游的要求填写 |
| 上游凭据 | 主线路自己的密钥 | 备用线路自己的密钥 |
| 上游功能 | 对话，`POST /chat/completions` | 对话，`POST /chat/completions` |
| 探测方法与路径 | 若支持则填 `GET /models` | 填该上游可用的探测路径 |

功能路径会追加到上游 Base URL。例如 Base URL `https://primary.example/v1` 和路径 `/chat/completions` 会组成 `https://primary.example/v1/chat/completions`。`Bearer ` 末尾留一个空格，网关会将前缀和凭据直接拼接。如果上游使用 `X-API-Key`，通常把前缀清空即可。保存后可在上游列表点击 **探测**。

### 2. 创建路由组

在 **路由组 → 新建路由组** 选择 **OpenAI 兼容**，对外别名填写 `chat-main`，功能选 **对话**。添加两个成员并将主线路放在第一位。需要为某一组指定不同模型时，可填写成员的 **覆盖模型**。

每个成员必须支持组内的每项功能和对应方法。若对话和向量嵌入使用不同模型，可各建一个路由组，例如 `chat-main` 和 `embed-main`，分别配置成员和权限。

### 3. 签发 Key 并配置客户端

在 **API Key → 签发 Key** 中为应用取名，勾选 `chat-main` 的对话功能，按需填写有效期和每分钟请求上限。完整 Key 只在签发时显示一次。

在支持自定义 OpenAI 兼容接口的客户端中填写以下值。远程部署时，将地址换成自己的 HTTPS 地址。

| 客户端字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 管理台刚签发的 `ooa_…` |
| 模型 ID | `chat-main` |

## 反代 HTTP 服务

假设已有查询接口 `GET https://inventory.example/v2/items?sku=A001`，可以通过网关为它单独发放权限。

1. 创建 **HTTP 反代** 上游。Base URL 填 `https://inventory.example/v2`，添加名为 `lookup` 的功能，方法选 `GET`，路径填 `/items`。按需填写上游凭据和健康探测路径。
2. 创建 **HTTP 反代** 路由组，别名填 `inventory`，公开功能配置为 `lookup` 和 `GET`。如有备用服务，为它配置同名同方法的功能，实际路径可不同。
3. 签发 Key 并勾选该组的 `lookup` 功能。客户端访问 `GET /api/inventory/lookup?sku=A001`，查询参数会转发给上游。

```bash
curl -fsS 'http://127.0.0.1:8787/api/inventory/lookup?sku=A001' \
  -H "X-API-Key: $OOA_API_KEY"
```

支持 `GET`、`HEAD`、`POST`、`PUT`、`PATCH` 和 `DELETE`，每个公开功能映射到预设方法和固定上游路径。带请求体的操作可传入数据，网关 Key 和客户端 Cookie 由网关处理。网页会话、WebSocket 和第三方登录由各自的服务处理。

## 多语言调用

以下对话示例统一使用 `chat-main`。在新终端设置变量，将占位值换成已签发的网关 Key。`OOA_BASE_URL` 在示例中指网关站点根地址，SDK 的 `base_url` 还需拼上 `/v1`。

<details open>
<summary><strong>macOS / Linux · curl</strong></summary>

```bash
export OOA_BASE_URL='http://127.0.0.1:8787'
export OOA_API_KEY='替换为网关签发的 Key'

curl -fsS "$OOA_BASE_URL/v1/models" \
  -H "Authorization: Bearer $OOA_API_KEY"

curl -fsS -N "$OOA_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OOA_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"model":"chat-main","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

`-N` 会关闭 curl 的输出缓冲。去掉 `stream` 或设为 `false` 即可获取普通 JSON 响应。

</details>

<details open>
<summary><strong>Windows · PowerShell</strong></summary>

```powershell
$env:OOA_BASE_URL = 'http://127.0.0.1:8787'
$env:OOA_API_KEY = '替换为网关签发的 Key'
$headers = @{ Authorization = "Bearer $env:OOA_API_KEY" }

Invoke-RestMethod -Uri "$env:OOA_BASE_URL/v1/models" -Headers $headers

$body = @{
  model = 'chat-main'
  messages = @(@{ role = 'user'; content = '你好' })
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod -Uri "$env:OOA_BASE_URL/v1/chat/completions" `
  -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$result.choices[0].message.content
```

</details>

<details>
<summary><strong>Python · OpenAI SDK</strong></summary>

先运行 `python3 -m pip install openai`。Windows 上如果使用 Python Launcher，可改用 `py -m pip install openai`。[Python SDK](https://github.com/openai/openai-python)

```python
import os
from openai import OpenAI

origin = os.getenv("OOA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
client = OpenAI(base_url=f"{origin}/v1", api_key=os.environ["OOA_API_KEY"], max_retries=0)

stream = client.chat.completions.create(
    model="chat-main",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

</details>

<details>
<summary><strong>JavaScript · Node.js fetch</strong></summary>

保存为 `chat.mjs`，运行 `node chat.mjs`。

```js
const origin = process.env.OOA_BASE_URL ?? 'http://127.0.0.1:8787';
const response = await fetch(new URL('/v1/chat/completions', origin), {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OOA_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'chat-main',
    messages: [{ role: 'user', content: '你好' }]
  })
});

const data = await response.json();
if (!response.ok) throw new Error(`HTTP ${response.status} · ${JSON.stringify(data)}`);
console.log(data.choices[0].message.content);
```

</details>

<details>
<summary><strong>Go · net/http</strong></summary>

保存为 `chat.go`，运行 `go run chat.go`。示例输出完整 JSON 响应。

```go
package main

import (
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "strings"
    "time"
)

func main() {
    origin := os.Getenv("OOA_BASE_URL")
    if origin == "" {
        origin = "http://127.0.0.1:8787"
    }
    payload := `{"model":"chat-main","messages":[{"role":"user","content":"你好"}]}`
    req, err := http.NewRequest("POST", strings.TrimRight(origin, "/")+"/v1/chat/completions", strings.NewReader(payload))
    if err != nil {
        log.Fatal(err)
    }
    req.Header.Set("Authorization", "Bearer "+os.Getenv("OOA_API_KEY"))
    req.Header.Set("Content-Type", "application/json")

    client := &http.Client{Timeout: 130 * time.Second}
    res, err := client.Do(req)
    if err != nil {
        log.Fatal(err)
    }
    defer res.Body.Close()
    body, err := io.ReadAll(res.Body)
    if err != nil {
        log.Fatal(err)
    }
    if res.StatusCode >= 400 {
        log.Fatalf("%s %s", res.Status, body)
    }
    fmt.Println(string(body))
}
```

</details>

### 接口速查

| 方法与路径 | 用途 | 关键参数 |
| --- | --- | --- |
| `GET /healthz` | 检查网关进程 | 无需 Key |
| `GET /v1/models` | 列出该 Key 有权访问的已启用 AI 路由 | Key |
| `POST /v1/chat/completions` | 对话，可流式返回 | `model`、`messages`、可选 `stream` |
| `POST /v1/responses` | Responses，可流式返回 | `model`、`input`、可选 `stream` |
| `POST /v1/embeddings` | 生成向量 | `model`、`input` |
| `/api/<路由别名>/<功能名>` | 调用固定 HTTP 功能 | 配置的方法、查询参数和请求体 |

除健康检查外，表中的接口接受 `Authorization: Bearer <网关 Key>` 或 `X-API-Key: <网关 Key>`。AI 请求中的 `model` 填路由别名，其余字段及成功响应由上游协议决定。每个功能需独立授权。请求体上限为 8 MiB。

## 切换规则

每次调用都从优先级最高的成员开始。网关跳过停用成员，并在路由组开启探测时对有探测配置的候选线路发起检查。GET / HEAD 探测收到 `2xx` 即通过。未配置探测路径时，用实际业务请求判断。兼容 Chat Completions 的上游也可使用 **POST 最小对话** 探测，可能消耗上游额度。

| 场景 | 行为 |
| --- | --- |
| 候选线路探测失败 | 跳过该成员，尝试下一条 |
| 连接失败、超时、`408`、`429` 或 `5xx` | 在允许重试且尚未输出时尝试下一条 |
| AI 上游返回 `401`、`402`、`403` 或 `404` | 视为当前线路不可用，允许重试时切换 |
| 通用 HTTP `GET` / `HEAD` | 允许自动切换 |
| 通用 HTTP 写请求 | 默认只在实际请求发出前切换，组内可显式开启重放 |
| AI 请求 | 默认允许输出前重试，可在组内关闭 |
| 已开始向客户端返回流 | 中断记录为失败，该请求的流到此结束 |

重放可能重复执行或计费。可分别设置组总超时、探测超时和单上游超时。若希望后备线路有机会接手，将单上游超时设得低于总超时，并预留探测和后备调用的时间。

## 部署与维护

### 环境变量

从 [`.env.example`](.env.example) 创建 `.env`。PowerShell 用 `Copy-Item .env.example .env`，macOS / Linux 用 `cp .env.example .env`。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OOA_HOST` | `127.0.0.1` | 监听地址 |
| `OOA_PORT` | `8787` | 监听端口 |
| `OOA_DATA_DIR` | `./data` | SQLite 和加密密钥所在目录，相对路径以启动目录为基准 |
| `OOA_ADMIN_PASSWORD` | 随机生成 | 首次启动或执行密码重置时使用，长度 16–256 字符 |
| `OOA_SECURE_COOKIE` | `0` | 通过 HTTPS 访问管理台时设为 `1` |

### HTTPS 与持久化

在 Windows、macOS 或 Linux 上自用时，可直接通过回环地址访问。远程部署时，可将进程继续绑定 `127.0.0.1`，由同一台机器上的 HTTPS 反向代理提供入口，并将 `OOA_SECURE_COOKIE` 设为 `1`。以下配置可放入已有的 Nginx HTTPS `server` 块。[Nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 610s;
    client_max_body_size 8m;
}
```

项目按单实例、单管理员设计。上游凭据使用 AES-256-GCM 加密，签发的网关 Key 仅保存摘要。备份时先停服务，再复制整个数据目录，包含 `gateway.sqlite` 和 `vault.key`，并限制备份的访问权限。恢复时把两者放回同一个数据目录。

重置管理员密码可在项目根目录执行以下命令。已有会话会立即失效。若设置了 `OOA_ADMIN_PASSWORD`，重置使用该值。

```sh
node --env-file-if-exists=.env src/server.js --reset-admin
```

## 排障

| 现象 | 检查项 |
| --- | --- |
| 管理台打不开 | 检查终端中的监听地址和端口，再访问 `/healthz` |
| 调用返回 `401` | 确认使用已启用且未过期的网关 Key |
| 调用返回 `403` | 检查 Key 是否获授这个路由组的这个功能 |
| 调用返回 `404` / `405` | 核对路由别名、功能和 HTTP 方法，并确认路由已启用 |
| 调用返回 `429` | 查看 `Retry-After` 及日志，判断是 Key 限流还是上游返回的限制 |
| 调用返回 `502` / `504` | 在 **调用日志** 中按路由筛选，展开尝试详情并对照响应的 `X-Request-ID` |
| 探测失败但模型可用 | 确认探测路径和方法受上游支持，或清空 GET / HEAD 探测路径以使用实际请求判断 |
| 流式响应集中到最后输出 | 确认客户端启用了 `stream`，反代关闭响应缓冲，curl 加了 `-N` |

管理台显示近 24 小时的请求量、成功率和切换次数。日志保留近 7 天并定期清理超过 2 万条的记录，记录路由、请求 ID、状态和上游尝试过程。请求体、查询参数及密钥字段均不写入调用日志。

## 开发与测试

```text
public/          中文管理台
src/server.js    HTTP 服务、管理接口与公开路由
src/config.js    上游、路由组和 API Key 配置校验
src/gateway.js   探测、转发和故障切换
src/store.js     SQLite 持久化与密钥存储
test/            本机模拟上游集成测试
```

```sh
node --test
```

测试使用临时 SQLite 和监听在回环地址的模拟服务，覆盖顺序切换、模型改写、SSE、HTTP 反代及 Key 权限。运行环境需允许本机回环连接。
