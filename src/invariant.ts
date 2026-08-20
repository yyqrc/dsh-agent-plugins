/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-plugins`.
 * @module @deepseek-ai/dsh-agent-plugins/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-plugins'

/** Cordis companion plugin name. */
export const name = 'agent-plugins-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this compatibility loader has no independent lifecycle
 * stream; registration relations are owned by the skill and command registries
 * it calls and the mounted mcp-client children.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
