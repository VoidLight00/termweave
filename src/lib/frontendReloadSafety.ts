let pending = 0;
/** Track only operations that could lose an acknowledgement on page navigation. */
export async function protectFrontendInput<T>(operation: () => Promise<T>): Promise<T> {
  pending += 1;
  try { return await operation(); } finally { pending -= 1; }
}
export function frontendInputPending(): boolean { return pending > 0; }

/** No storage is cleared and no input is sent. Unpersisted form/attachment data needs consent. */
export function pageHasDrafts(document: Document): boolean {
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")]
    .some(input => !input.readOnly && input.type !== "checkbox" && input.type !== "radio" && input.value.length > 0)
    || document.querySelector(".composer-attachments, .draft-held, .draft-text, .composer-queue") !== null;
}
