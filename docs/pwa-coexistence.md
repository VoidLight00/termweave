# PWA coexistence boundary

TermWeave cache reads and deletes are limited to its own cache namespace. Cookies and preferences are independent. However service-worker scope and manifest identity are origin-scoped: deploy upstream and TermWeave on different origins/ports. Same-origin root-scoped workers cannot simultaneously own the same pages. Separate cache namespaces do not remove that browser platform constraint.
