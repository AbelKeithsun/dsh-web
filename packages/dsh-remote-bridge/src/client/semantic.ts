/**
 * Semantic attribute values for the protocol v1 pairing panel (contract:
 * skins/skin-center/contracts/semantic-attrs-v1.md). Root containers carry
 * `data-dsh-plugin`; parts carry bare `data-dsh-part` values owned by that
 * plugin attribute.
 */

/** Plugin short name stamped on the footer trigger and the modal root. */
export const PLUGIN_ATTR = 'remote-bridge'

/** The sidebar footer seat trigger. */
export const PART_ENTRY = 'entry'

/** The modal panel root. */
export const PART_PANEL = 'panel'

/** The QR symbol's wrapper — it also mirrors the encoded string. */
export const PART_QR = 'qr'

/** The plaintext pairing code row. */
export const PART_TOKEN = 'token'

/** A state notice: the origin warning, or a refusal the host raised. */
export const PART_NOTICE = 'notice'

/** The mint-again button. */
export const PART_REFRESH = 'refresh'

/** The copy-the-code button. */
export const PART_COPY = 'copy'

/**
 * Attribute carrying the exact string the QR symbol encodes, so the operator
 * (and a UI check) can compare it against the host route's answer without
 * decoding the symbol. The same string is already on screen in plaintext.
 */
export const QR_VALUE_ATTR = 'data-dsh-qr-value'
