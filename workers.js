/**
 * Docker Registry 代理 Worker
 *
 * 功能说明：
 * 1. 根路径请求重定向到 Docker 官网
 * 2. 针对 /v2/ 请求返回带有 WWW-Authenticate 挑战的响应，
 *    引导 Docker 客户端获取认证 Token。
 * 3. 针对 /auth/token 请求，从 Docker 授权服务获取认证 Token。
 * 4. 对于其他请求（如拉取镜像配置或镜像数据），转发到上游 Docker Registry，
 *    并在必要时对请求路径进行调整（例如缺失默认命名空间时自动补全 "library"）。
 * 5. 为防止 Worker 自动跟随重定向时丢失关键请求头，所有代理请求均设置重定向策略为 manual。
 *
 * 代码思路来源：
 * https://voxsay.com/posts/china-docker-registry-proxy-guide/
 */

// 定义上游 Docker Registry 地址（固定地址）
const DOCKER_REGISTRY = 'https://registry-1.docker.io'

/**
 * 注册 fetch 事件监听器，Worker 接收到请求后调用 handleRequest 函数处理
 */
addEventListener('fetch', event => {
  // 遇到异常时，透传请求
  event.passThroughOnException()
  event.respondWith(handleRequest(event.request))
})

/**
 * 主请求处理函数，根据 URL 的不同路径分发到对应的处理逻辑
 *
 * @param {Request} request - 当前请求对象
 * @returns {Promise<Response>} - 返回响应对象
 */
async function handleRequest(request) {
  // 解析请求 URL
  const url = new URL(request.url)
  // 获取访问时使用的域名（动态获取，不再使用固定 PROXY_REGISTRY）
  const host = url.host
  const path = url.pathname

  // 1. 如果是根路径请求，重定向到 Docker 官网
  if (path === '/') {
    return Response.redirect('https://www.docker.com', 301)
  }

  // 2. 对 /v2/ 请求返回认证挑战信息
  if (path === '/v2/') {
    return challenge(DOCKER_REGISTRY, host)
  }

  // 3. 对 Token 请求进行处理
  if (path === '/auth/token') {
    return getToken(url)
  }

  // 4. 检查路径是否缺少默认的命名空间
  //    格式通常为：/v2/仓库名/操作/标签，分割后数组长度为 5 表示缺少命名空间
  const parts = path.split('/')
  if (parts.length === 5) {
    // 在仓库名称前插入 "library"
    parts.splice(2, 0, 'library')
    // 构造新的 URL，使用访问时的域名 host 代替固定的 PROXY_REGISTRY
    const newUrl = new URL(`https://${host}`)
    newUrl.pathname = parts.join('/')
    return Response.redirect(newUrl.toString(), 301)
  }

  // 5. 默认转发请求到上游 Docker Registry
  return getData(DOCKER_REGISTRY, request)
}

/**
 * 返回带有 WWW-Authenticate 挑战头的响应，
 * 用于引导客户端按照 Bearer 认证流程获取 Token
 *
 * @param {string} upstream - 上游 Docker Registry 地址
 * @param {string} host - 当前请求的域名，用于构造 Token 请求的 realm
 * @returns {Promise<Response>} - 返回响应对象
 */
async function challenge(upstream, host) {
  // 请求上游 /v2/ 端点
  const url = new URL(`${upstream}/v2/`)
  const upstreamResponse = await fetch(url)
  const responseBody = await upstreamResponse.text()

  // 构造新的响应头，设置 WWW-Authenticate 挑战信息
  const headers = new Headers()
  headers.set(
    'WWW-Authenticate',
    `Bearer realm="https://${host}/auth/token",service="docker-proxy-worker"`
  )

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  })
}

/**
 * 处理 Token 请求，调用 Docker 授权服务获取认证 Token
 *
 * @param {URL} originUrl - 请求 URL 对象，包含查询参数 scope
 * @returns {Promise<Response>} - 返回授权服务的响应
 */
async function getToken(originUrl) {
  // 处理 scope 参数，自动补全缺失的 "library" 命名空间
  const scope = processScope(originUrl)
  
  // 构造 Docker 授权服务的请求 URL
  const tokenUrl = new URL('https://auth.docker.io/token')
  tokenUrl.searchParams.set('service', 'registry.docker.io')
  tokenUrl.searchParams.set('scope', scope)
  
  return fetch(tokenUrl)
}

/**
 * 代理请求到上游 Docker Registry
 *
 * 为避免 Worker 自动跟随重定向时丢失关键请求头，
 * 设置 redirect 为 'manual'，将重定向响应原样返回给客户端
 *
 * @param {string} upstream - 上游 Docker Registry 地址
 * @param {Request} req - 当前请求对象
 * @returns {Promise<Response>} - 返回代理请求的响应
 */
async function getData(upstream, req) {
  const originUrl = new URL(req.url)
  // 构造上游请求 URL
  const targetUrl = new URL(`${upstream}${originUrl.pathname}`)
  
  // 创建新的请求对象，保留原始方法和请求头，并设置重定向策略为手动
  const proxyRequest = new Request(targetUrl, {
    method: req.method,
    headers: req.headers,
    redirect: 'manual'
  })

  return fetch(proxyRequest)
}

/**
 * 处理 scope 参数，确保仓库名称中包含默认的 "library" 命名空间
 *
 * 通常 scope 格式为 "repository:仓库名:操作"（例如 "repository:ubuntu:pull"）。
 * 如果仓库名中没有 "/"，则自动在前面添加 "library/"。
 *
 * @param {URL} url - 请求 URL 对象，包含 scope 查询参数
 * @returns {string} - 处理后的 scope 字符串
 */
function processScope(url) {
  let scope = url.searchParams.get('scope')
  const parts = scope.split(':')
  if (parts.length === 3 && !parts[1].includes('/')) {
    parts[1] = 'library/' + parts[1]
    scope = parts.join(':')
  }
  return scope
}
