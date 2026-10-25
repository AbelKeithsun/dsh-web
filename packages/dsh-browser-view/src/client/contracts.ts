/**
 * Slot contract this package registers into, restated locally.
 *
 * 'conversation.session.header.actions' is declared by
 * @deepseek-ai/dsh-client-ui-conversation, which is NOT on this package's
 * dependency path; without the restatement the key would be rejected as
 * undeclared at every register call.
 *
 * The two right-sidebar pane seats ('sidebar.right.pane.tab' and
 * 'sidebar.right.pane.tab.title') are deliberately NOT restated any more. Their
 * owner, @deepseek-ai/dsh-client-ui-sidebar-right, is now a devDependency of
 * this package and declares both keys itself, which is the condition this
 * package's AGENTS.md names for dropping a local copy. Restating them is not
 * possible either: their declaration carries
 * `hookContext: TabHookContext` and `inject: SidebarRightTabInjected`, and the
 * owner's barrel exports the second but not the first, so a local copy cannot
 * name the same type and TS2717 rejects the duplicate member.
 *
 * The file is type-only: it emits nothing.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * List slot in the session header action row. Additive: a fresh id sits
     * beside the shipped entries instead of replacing them.
     */
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
    }
  }
}

export {}
