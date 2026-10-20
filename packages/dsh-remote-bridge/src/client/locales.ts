/**
 * `remote-bridge` namespace dictionaries: the protocol v1 pairing panel copy.
 *
 * The panel has one job — put the live one-shot code in front of the operator as
 * a QR symbol — so the copy carries exactly four things: what to do with the
 * symbol, how long it lives, which address the phone will actually dial, and why
 * the code is single-use. No key states how the host finds its public address:
 * that is an implementation fact the reader cannot act on.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'entry.label': '配对手机（协议 v1）',
  'title': '协议 v1 配对',
  'subtitle': '用手机 App 扫描二维码，即可让手机以协议 v1 连上这台宿主。配对码由本机签发，只在本机显示。',
  'state.reading': '正在取配对码…',
  'pair.qrLabel': '配对二维码',
  'pair.countdown': '剩余 {s} 秒',
  'pair.expired': '配对码已过期',
  'pair.refresh': '重新取码',
  'pair.usedHint': '配对码一次性有效：手机一开始配对即作废，重新取码也会作废上一张。',
  'origin.located': '手机将连到 {origin}',
  'origin.missing': '没有找到公网地址：请先在手机里把连接地址填成你的公网中继，再扫码。本页的 {host} 只有本机能连。',
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
  'subtitle': 'Scan the QR code with the phone app to let the phone reach this host over protocol v1. The code is minted by this machine and shown only here.',
  'state.reading': 'Requesting a pairing code…',
  'pair.qrLabel': 'Pairing QR code',
  'pair.countdown': '{s} s left',
  'pair.expired': 'The pairing code expired',
  'pair.refresh': 'New code',
  'pair.usedHint': 'The code is single-use: pairing spends it, and a new code voids the previous one.',
  'origin.located': 'The phone will dial {origin}',
  'origin.missing': 'No public address found: set the phone app to your public relay first, then scan. {host} (this page) is reachable only from this machine.',
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
