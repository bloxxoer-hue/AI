// человекоподобные действия: живой темп набора, микро-паузы, не мгновенные клики

const rand = (min, max) => min + Math.random() * (max - min);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function humanType(locator, text) {
  await locator.click();
  await sleep(rand(120, 340));
  for (const ch of text) {
    await locator.type(ch, { delay: rand(25, 95) });
    if (Math.random() < 0.06) await sleep(rand(140, 420));
  }
  await sleep(rand(150, 380));
}

export async function humanClick(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(rand(120, 320));
  await locator.click();
  await sleep(rand(200, 520));
}

export async function humanFill(textarea, text) {
  // быстрее, чем посимвольно, но с предварительной паузой — как человек, который уже знает, что пишет
  await textarea.click();
  await sleep(rand(150, 400));
  await textarea.fill(text);
  await sleep(rand(250, 600));
}

export function progressLogger(prefix, onProgress) {
  return (msg) => onProgress?.(`${prefix} ${msg}`);
}
