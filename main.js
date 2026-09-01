const CHECKIN_URL = 'https://glados.rocks/api/user/checkin'
const STATUS_URL = 'https://glados.rocks/api/user/status'

const normalizeText = (value) => String(value ?? '').trim()

const isAlreadyCheckedIn = (message) => {
  const text = normalizeText(message).toLowerCase()

  return (
    text.includes('please try tomorrow') ||
    text.includes('checkin repeats') ||
    text.includes('try tomorrow') ||
    text.includes('already check') ||
    text.includes('already signed') ||
    text.includes('今日已签到') ||
    text.includes('已签到')
  )
}

const isAuthFailure = (message) => {
  const text = normalizeText(message).toLowerCase()

  return (
    text.includes('login') ||
    text.includes('cookie') ||
    text.includes('unauthor') ||
    text.includes('forbidden') ||
    text.includes('session') ||
    text.includes('not logged') ||
    text.includes('未登录') ||
    text.includes('登录失效')
  )
}

const requestJson = async (url, options) => {
  const response = await fetch(url, options)

  let data

  try {
    data = await response.json()
  } catch {
    throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`)
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  }
}

const glados = async () => {
  const cookie = normalizeText(process.env.GLADOS)

  if (!cookie) {
    return {
      ok: false,
      title: 'Cookie失效',
      status: 'COOKIE_MISSING',
      lines: [
        '❌ Cookie失效：环境变量 GLADOS 为空或未配置。',
      ],
    }
  }

  const headers = {
    cookie,
    referer: 'https://glados.rocks/console/checkin',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 Chrome/120 Safari/537.36',
  }

  try {
    const checkin = await requestJson(CHECKIN_URL, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        token: 'glados.one',
      }),
    })

    const status = await requestJson(STATUS_URL, {
      method: 'GET',
      headers,
    })

    const checkinMessage = normalizeText(checkin.data?.message)
    const statusMessage = normalizeText(status.data?.message)

    const leftDaysRaw = status.data?.data?.leftDays
    const leftDays = Number(leftDaysRaw)

    const statusDataValid =
      status.ok &&
      status.data?.data &&
      leftDaysRaw !== undefined &&
      leftDaysRaw !== null &&
      Number.isFinite(leftDays)

    /*
     * Cookie / 登录状态失效判断
     */
    if (
      checkin.status === 401 ||
      checkin.status === 403 ||
      status.status === 401 ||
      status.status === 403 ||
      isAuthFailure(checkinMessage) ||
      isAuthFailure(statusMessage) ||
      !statusDataValid
    ) {
      return {
        ok: false,
        title: 'Cookie失效',
        status: 'COOKIE_INVALID',
        lines: [
          '❌ Cookie失效：GLaDOS 登录状态无效，请更新 GitHub Secret：GLADOS。',
          checkinMessage
            ? `接口信息：${checkinMessage}`
            : null,
        ].filter(Boolean),
      }
    }

    const leftDaysText = Number.isInteger(leftDays)
      ? String(leftDays)
      : leftDays
          .toFixed(2)
          .replace(/0+$/, '')
          .replace(/\.$/, '')

    /*
     * 今日已经签到
     */
    if (isAlreadyCheckedIn(checkinMessage)) {
      return {
        ok: true,
        title: '今日已签到',
        status: 'ALREADY_CHECKED_IN',
        lines: [
          'ℹ️ 今日已签到，无需重复签到。',
          checkinMessage
            ? `接口信息：${checkinMessage}`
            : null,
          `剩余天数：${leftDaysText}`,
        ].filter(Boolean),
      }
    }

    /*
     * 正常签到成功
     */
    if (checkin.ok && checkinMessage) {
      return {
        ok: true,
        title: '签到成功',
        status: 'CHECKIN_SUCCESS',
        lines: [
          '✅ 签到成功。',
          `接口信息：${checkinMessage}`,
          `剩余天数：${leftDaysText}`,
        ],
      }
    }

    /*
     * 接口有响应，但不符合成功条件
     */
    return {
      ok: false,
      title: '签到失败',
      status: 'CHECKIN_FAILED',
      lines: [
        `❌ 签到失败：GLaDOS 签到接口返回异常（HTTP ${checkin.status}）。`,
        checkinMessage
          ? `接口信息：${checkinMessage}`
          : '接口未返回有效 message。',
      ],
    }
  } catch (error) {
    return {
      ok: false,
      title: '签到失败',
      status: 'REQUEST_ERROR',
      lines: [
        '❌ 签到失败：请求或响应解析发生异常。',
        `错误信息：${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
        process.env.GITHUB_SERVER_URL &&
        process.env.GITHUB_REPOSITORY
          ? `仓库：<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
          : null,
      ].filter(Boolean),
    }
  }
}

const notify = async (result) => {
  const token = normalizeText(process.env.NOTIFY)

  /*
   * NOTIFY 没配置时不影响签到结果
   */
  if (!token || !result) {
    return true
  }

  try {
    const response = await fetch(
      'https://www.pushplus.plus/send',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          token,
          title: `GLaDOS ${result.title}`,
          content: result.lines.join('<br>'),
          template: 'markdown',
        }),
      },
    )

    if (!response.ok) {
      console.warn(
        `⚠️ PushPlus 通知失败：HTTP ${response.status}`,
      )
      return false
    }

    console.log('✅ PushPlus 通知发送成功。')
    return true
  } catch (error) {
    console.warn(
      `⚠️ PushPlus 通知失败：${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    )

    return false
  }
}

const printResult = (result) => {
  console.log('========================================')
  console.log('GLaDOS Auto Check-in')
  console.log('========================================')

  console.log(`状态：${result.title}`)

  for (const line of result.lines) {
    console.log(line)
  }

  console.log(`结果代码：${result.status}`)
  console.log('========================================')
}

const main = async () => {
  const result = await glados()

  printResult(result)

  /*
   * 通知失败不等同于签到失败，因此不改变签到退出码
   */
  await notify(result)

  /*
   * 真正的签到失败 / Cookie失效：
   * GitHub Actions 必须显示失败。
   */
  if (!result.ok) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('❌ 签到失败：程序发生未处理异常。')
  console.error(
    error instanceof Error
      ? error.message
      : String(error),
  )

  process.exitCode = 1
})
