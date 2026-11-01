export const set = (el: HTMLElement, v: string) => el.style.setProperty("--sk-accent", v); // expect T12
export const vars = { "--sk-ink": "inherit" }; // expect T12
