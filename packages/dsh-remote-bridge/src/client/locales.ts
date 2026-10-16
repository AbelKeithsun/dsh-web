/**
 * `remote-bridge` namespace dictionaries: the protocol v1 pairing panel copy.
 *
 * The panel has one job — show the operator the one-shot bootstrap token as a
 * QR symbol plus its plaintext — so the copy is dominated by the two facts a
 * reader has to get right: where the phone's origin points (the public relay,
 * never this machine's loopback address) and why the token vanished (30 s, one
 * use, or a fresh mint).
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'entry.label': '配对手机（协议 v1）',
  'title': '协议 v1 配对',
  'subtitle': '用手机 App 扫描下方二维码，即可以协议 v1 配对这台宿主。配对码由本机签发，仅在本机可读。',
  'state.reading': '正在取配对码…',
  'pair.qrLabel': '配对二维码',
  'pair.tokenLabel': '配对码（明文，与二维码内容逐字一致）',
  'pair.countdown': '剩余 {s} 秒',
  'pair.expired': '配对码已过期（30 秒）',
  'pair.expiredHint': '过期的配对码不会被手机接受，请重新取码。',
  'pair.usedHint': '配对码一次性：手机调用 pair.begin 的瞬间即作废，重新取码也会作废上一张。',
  'pair.refresh': '重新取码',
  'origin.title': '手机端的 Origin 要填公网中继地址',
  'origin.body': '上面二维码只装裸配对码，不含地址。手机 App 的连接地址必须填你的公网中继，形如 wss://<id>.dsh-market.com；本页所在的 {host} 只有本机能连，手机连不上。',
  'forbidden.title': '这个页面不是从本机打开的',
  'forbidden.body': '配对码只能在本机 Web UI 上取。请在本机浏览器打开 http://127.0.0.1:<端口> 后重试。',
  'failed.title': '取配对码失败',
  'failed.body': '宿主返回了 HTTP {status}，请刷新页面后重试。',
  'unreachable.title': '无法连接本机宿主',
  'unreachable.body': '请求没有到达宿主，请确认 dsh web 仍在运行后重试。',
  'action.close': '关闭',
  'action.copy': '复制配对码',
  'action.copied': '已复制',
  'action.copyFailed': '复制失败',
  'action.retry': '重试',
} as const

/** English dictionary, key-for-key with the zh source. */
export const en: Record<RemoteBridgeKey, string> = {
  'entry.label': 'Pair a phone (protocol v1)',
  'title': 'Protocol v1 pairing',
  'subtitle': 'Scan the QR code with the phone app to pair it with this host over protocol v1. The code is minted by this machine and only readable here.',
  'state.reading': 'Requesting a pairing code…',
  'pair.qrLabel': 'Pairing QR code',
  'pair.tokenLabel': 'Pairing code (plaintext, byte-for-byte what the QR encodes)',
  'pair.countdown': '{s} s left',
  'pair.expired': 'The pairing code expired (30 s)',
  'pair.expiredHint': 'An expired code is never accepted; request a new one.',
  'pair.usedHint': 'The code is single-use: the phone spends it the moment it calls pair.begin, and requesting a new one voids the previous code.',
  'pair.refresh': 'New code',
  'origin.title': 'The phone origin must be the public relay',
  'origin.body': 'The QR carries the bare pairing code and no address. Set the phone app to your public relay, such as wss://<id>.dsh-market.com; {host} (this page) is reachable only from this machine and never from the phone.',
  'forbidden.title': 'This page is not open on this machine',
  'forbidden.body': 'Pairing codes can only be read from the machine itself. Open http://127.0.0.1:<port> in a browser on this machine and retry.',
  'failed.title': 'Could not read a pairing code',
  'failed.body': 'The host answered HTTP {status}. Reload the page and retry.',
  'unreachable.title': 'Cannot reach the local host',
  'unreachable.body': 'The request never reached the host. Check that dsh web is still running and retry.',
  'action.close': 'Close',
  'action.copy': 'Copy pairing code',
  'action.copied': 'Copied',
  'action.copyFailed': 'Copy failed',
  'action.retry': 'Retry',
}

/** Every key the `remote-bridge` namespace carries. */
export type RemoteBridgeKey = keyof typeof zh
