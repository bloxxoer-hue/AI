// пул заранее зарегистрированных slice-аккаунтов с кредитами:
// пока пользователь ждёт только рендер, фон уже успел и код, и триал
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./session.js";

const POOL_DIR = path.join(ROOT, "rpa", "pool");
fs.mkdirSync(POOL_DIR, { recursive: true });
const READY_FILE = path.join(POOL_DIR, "ready.json");

function readReady() {
  try { return JSON.parse(fs.readFileSync(READY_FILE, "utf8")); } catch { return []; }
}
function writeReady(list) {
  fs.writeFileSync(READY_FILE, JSON.stringify(list, null, 2));
}

export function count() {
  return readReady().filter((i) => fs.existsSync(i.state)).length;
}

/** забирает готовый аккаунт; сразу планирует пополнение */
export function pop() {
  const list = readReady();
  const item = list.find((i) => fs.existsSync(i.state));
  if (!item) return null;
  writeReady(list.filter((i) => i !== item));
  return item;
}

export function push(statePath, balance) {
  const list = readReady();
  list.push({ state: statePath, balance, createdAt: Date.now() });
  writeReady(list);
}

export function pendingFile(tag) {
  return path.join(POOL_DIR, `state-${tag}.json`);
}

export function discard(file) {
  try { fs.unlinkSync(file); } catch {}
}
