export function fitTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "0px";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}
