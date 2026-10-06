/** Keep injected sections after Personal when native search rebuilds the list. */
export function placeSettingsGroupsAfterPersonal(
  sidebar: HTMLElement,
  navGroup: HTMLElement | null,
  pagesGroup: HTMLElement | null,
): void {
  if (!navGroup) return;

  // Use the native panel identifier rather than the translated category title.
  const personal = Array.from(sidebar.children).find((section) =>
    section.querySelector('[data-settings-panel-slug="general-settings"]'),
  );
  // Search can omit Personal entirely. Preserve the existing placement until
  // its native section returns, then restore the order on that observer tick.
  if (!personal) return;

  let previous = personal;
  for (const group of [navGroup, pagesGroup]) {
    if (!group) continue;
    // Avoid writes when ordered: each move triggers our MutationObserver.
    if (previous.nextElementSibling !== group) {
      sidebar.insertBefore(group, previous.nextElementSibling);
    }
    previous = group;
  }
}
