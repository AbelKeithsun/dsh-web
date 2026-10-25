/**
 * Fake right-sidebar service for the browser-half tests.
 *
 * The plugin binds the real service once (sidebar-tabs.ts) and hands the
 * resulting face to the header shortcut, so a test records what the shortcut
 * asks the column to do by giving the shell this recording service instead of
 * patching the module graph.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** One tab the fake column holds. */
export interface FakeTab {
  /** Tab identity. */
  readonly id: string
  /** Tab type discriminator. */
  readonly kind: string
}

/** Recording navigation face plus the tab inventory behind it. */
export interface FakeSidebar {
  /** Shape handed to the plugin as ctx.sidebarRight. */
  readonly service: Record<string, unknown>
  /** Tabs this column holds, per session. */
  readonly inventory: Map<string, ReadonlyArray<FakeTab>>
  /** Open calls in order, as (session, kind) pairs. */
  readonly opened: ReadonlyArray<{ readonly sessionId: string; readonly kind: string }>
  /** Focus calls in order, by tab id. */
  readonly focused: ReadonlyArray<string>
  /**
   * Put a tab in a session before the plugin is pressed.
   * @param sessionId - session the tab belongs to.
   * @param tab - the tab record.
   */
  declareTab(sessionId: string, tab: FakeTab): void
  /** Drop everything recorded and declared. */
  reset(): void
}

/**
 * Build one recording column.
 * @param options - `refusesTabs` reproduces a session whose store the runtime has not adopted.
 * @returns the fake.
 */
export function createFakeSidebar(options: { refusesTabs?: boolean } = {}): FakeSidebar {
  const inventory = new Map<string, ReadonlyArray<FakeTab>>()
  const opened: Array<{ sessionId: string; kind: string }> = []
  const focused: string[] = []
  const self: FakeSidebar = {
    inventory,
    opened,
    focused,
    service: {
      tabsIn(sessionId: string): ReadonlyArray<FakeTab> {
        if (options.refusesTabs === true) throw new Error('the session store was never adopted')
        return inventory.get(sessionId) ?? []
      },
      focus(tabId: string): void {
        focused.push(tabId)
      },
      openTabIn(sessionId: string, kind: string): void {
        opened.push({ sessionId, kind })
      },
    },
    declareTab(sessionId: string, tab: FakeTab): void {
      inventory.set(sessionId, [...(inventory.get(sessionId) ?? []), tab])
    },
    reset(): void {
      inventory.clear()
      opened.length = 0
      focused.length = 0
    },
  }
  return self
}

/** Recording tab-type registry. */
export interface FakeTabRegistry {
  /** Shape handed to the plugin as ctx.sidebarRightTabs. */
  readonly service: Record<string, unknown>
  /** Definitions registered so far, in order. */
  readonly definitions: ReadonlyArray<SidebarRightTabDefinition>
  /** How many registered types have been disposed. */
  readonly disposed: () => number
}

/**
 * Build one recording tab-type registry.
 * @param options - `refusesRegistration` reproduces a kind already held in the same band.
 * @returns the fake.
 */
export function createFakeTabRegistry(options: { refusesRegistration?: boolean } = {}): FakeTabRegistry {
  const definitions: SidebarRightTabDefinition[] = []
  let disposed = 0
  const service = {
    register(definition: SidebarRightTabDefinition): () => void {
      if (options.refusesRegistration === true) throw new Error('the kind is already registered')
      definitions.push(definition)
      return () => {
        disposed += 1
      }
    },
  }
  return { service, definitions, disposed: () => disposed }
}
