(function (inputTask) {
  function normalize(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+\*$/, "")
      .trim();
  }
  function normalizeLoose(value) {
    return normalize(value).replace(/\s+/g, "");
  }
  function isVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  const containers = Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae'))
    .filter(isVisible)
    .filter((node) => node.querySelector('[role="heading"]'));
  inputTask.payload.fieldSpecs
    .filter((field) => field.kind === "dropdown")
    .forEach((field) => {
      const expectedLoose = normalizeLoose(inputTask.payload.answers[field.title]);
      if (!expectedLoose) return;
      const container = containers.find((node) => {
        const title = normalize(node.querySelector('[role="heading"]')?.textContent || "");
        return title === normalize(field.title) || title.startsWith(normalize(field.title));
      });
      if (!container) return;
      const listbox = container.querySelector('[role="listbox"]');
      if (listbox) {
        listbox.setAttribute("data-gc-autofill-listbox", "true");
      }
      const options = Array.from(container.querySelectorAll('[role="option"][data-value]'));
      const option = options.find((node) => normalizeLoose(node.getAttribute("data-value")) === expectedLoose)
        || options.find((node) => normalizeLoose(node.textContent) === expectedLoose);
      if (!option) return;
      option.setAttribute("data-gc-autofill-match", "true");
    });
  return Array.from(document.querySelectorAll('[role="option"][data-gc-autofill-match="true"]')).length;
})
