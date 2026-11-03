// авто-регистрация через temp-почту: h3-max (письмо → verify-ссылка),
// polyfaced (без верификации), slice (6-значный код из письма)
import { newAddress, waitMessage, messageLink, extractCode } from "./mail.js";
import { sleep } from "./human.js";

const PASSWORD = "VidStuDio!2026x";
const NAME = "studio nyx";

/** h3-max.me: Sign up → письмо Confirm email → verify-ссылка → автологин */
export async function registerH3(page, onProgress) {
  const log = (m) => onProgress?.(`h3: ${m}`);
  const mailPage = await page.context().newPage();
  try {
    let addr = null;
    // цикл живёт и по форме (400 Invalid email), и по письму: несли read-письма —
    // следующая попытка уже на emailnator, там verify-ссылка как настоящий <a>
    for (let attempt = 1; attempt <= 4 && !addr; attempt++) {
      // свежая страница на каждую попытку — отказ формы оставляет мёртвый диалог
      await page.goto("https://h3-max.me/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1500);

      // 1-я попытка — temp-mail (любой домен); h3 отвергает часть временных
      // доменов (400 Invalid email) — дальше переключаемся на emailnator (gmail)
      const provider = attempt === 1 ? "tempmail" : "emailnator";
      const a = await newAddress(mailPage, provider);
      addr = a.addr;
      log(`temp-почта (${a.kind}): ${addr}`);

      await page.click('[data-testid="navbar-login-trigger"]', { timeout: 20000 }).catch(() => {});
      await page.click('button:has-text("Sign up")', { timeout: 8000 }).catch(() => {});
      await page.fill('input[name="name"]', NAME);
      await page.fill('input[name="email"]', addr);
      await page.fill('input[name="password"]', PASSWORD);
      await page.fill('input[name="confirmPassword"]', PASSWORD);

      // судьба попытки решается по auth-API: UI после успеха уже не показывает "Check your inbox"
      const authResp = page.waitForResponse(
        (r) => /api\/auth\/sign-?up/i.test(r.url()) && r.request().method() === "POST",
        { timeout: 60000 }
      ).catch(() => null);
      await page.click('[data-testid="auth-register-submit"]');

      const resp = await authResp;
      if (!(resp && resp.ok())) {
        const respInfo = resp ? `HTTP ${resp.status()}` : "ответ не пришёл";
        let why = "";
        if (resp) {
          why = await resp.text().then((t) => {
            try { return JSON.stringify(JSON.parse(t)).slice(0, 120); } catch { return t.slice(0, 120); }
          }).catch(() => "");
        }
        if (!why) {
          why = await page.evaluate(() => {
            const bad = document.querySelector('input[aria-invalid="true"]');
            if (bad) return "invalid field: " + bad.name;
            return (document.body.innerText.split("\n").find((l) =>
              /invalid email|already registered|password.*(short|match)|too short|error|failed/i.test(l)) || "").trim();
          });
        }
        log(`попытка ${attempt} не прошла [${respInfo}]${why ? ` (${why})` : ""} — пробую другой адрес`);
        addr = null;
        continue;
      }
      log("регистрация принята (200), читаю письмо...");

      try {
        // temp-mail приходит медленно/не всегда — резерв меньше; emailnator (попытки 2+) основной
        const mailTimeout = provider === "tempmail" ? 45000 : 120000;
        await readVerifyAndLogin(page, mailPage, log, addr, mailTimeout);
        break; // всё ок
      } catch (mailErr) {
        log(`письмо/verify не вышло (${mailErr.message}) — попытка ${attempt + 1}, другой провайдер`);
        addr = null;
      }
    }
    if (!addr) throw new Error("h3: не удалось получить рабочий аккаунт за 4 попытки");
    log("аккаунт готов");
  } finally {
    await mailPage.close().catch(() => {});
  }
}

/** письмо → verify-ссылка → подтверждение; бросает, если что-то не вышло */
async function readVerifyAndLogin(page, mailPage, log, addr, mailTimeout = 120000) {
  const msg = await waitMessage(mailPage, /h3-max/i, mailTimeout);
  let verifyUrl = messageLink(msg.links, /verify-email/i);

  // ссылка может быть спрятана — достаём из HTML письма тем же интерфейсом
  if (!verifyUrl) {
    const html = await mailPage.content();
    const m = html.match(/https?:\/\/[^\s"'<>\\]+verify-email[^\s"'<>\\]*/i);
    if (m) verifyUrl = m[0].replace(/&amp;/g, "&");
  }

  // кнопка с JS-переходом — кликаем и ловим навигацию/попап
  if (!verifyUrl) {
    const navP = mailPage.waitForNavigation({ timeout: 15000 }).catch(() => null);
    const popupP = mailPage.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
    await mailPage.getByText(/confirm email/i).first().click({ timeout: 8000 }).catch(() => {});
    const popup = await popupP;
    const nav = await navP;
    if (popup) {
      verifyUrl = popup.url();
      await popup.close().catch(() => {});
    } else if (nav) {
      verifyUrl = nav.url();
    }
    if (!verifyUrl && mailPage.url().includes("h3-max")) verifyUrl = mailPage.url();
  }

  if (!verifyUrl || !verifyUrl.includes("h3-max")) {
    throw new Error("verify-ссылка не найдена в письме");
  }
  await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3000);
  log("email подтверждён");

  // verify с callbackURL обычно сразу логинит — иначе входим сами
  if (!(await h3LoggedIn(page))) {
    log("вхожу email/password…");
    await page.click('[data-testid="navbar-login-trigger"]', { timeout: 15000 });
    await page.click('button:has-text("Sign in with email")', { timeout: 10000 });
    await page.fill('input[type="email"]', addr);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]', { timeout: 10000 });
    await sleep(4000);
    if (!(await h3LoggedIn(page))) throw new Error("вход не подтвердился после verify");
  }
}

async function h3LoggedIn(page) {
  if (!page.url().includes("h3-max.me")) return false;
  const signIn = page.locator('header button:has-text("Sign in")').first();
  if ((await signIn.count()) === 0) return true;
  return !(await signIn.isVisible().catch(() => false));
}

/** polyfaced.com: /sign-up без верификации, студия открывается сразу */
export async function registerPolyfaced(page, onProgress) {
  const log = (m) => onProgress?.(`polyfaced: ${m}`);
  const mailPage = await page.context().newPage();
  try {
    await page.goto("https://polyfaced.com/sign-up", { waitUntil: "domcontentloaded", timeout: 60000 });
    const a = await newAddress(mailPage);
    log(`temp-почта (${a.kind}): ${a.addr}`);

    await page.fill("#name", NAME);
    await page.fill("#email", a.addr);
    await page.fill("#password", PASSWORD);
    await page.fill("#confirmPassword", PASSWORD);
    await page.click('form button[type="submit"], form button:has-text("Sign Up")');
    await page.waitForURL(/\/(studio|$)/, { timeout: 30000 }).catch(() => {});
    log("аккаунт создан");
  } finally {
    await mailPage.close().catch(() => {});
  }
}

/** slice.video: email → 6-значный код из письма → дашборд */
export async function registerSlice(page, onProgress) {
  const log = (m) => onProgress?.(`slice: ${m}`);
  const mailPage = await page.context().newPage();
  try {
    await page.goto("https://slice.video/registration/new", { waitUntil: "domcontentloaded", timeout: 60000 });
    // slice блокирует явно-временные домены — для него emailnator c gmail-выбором
    const a = await newAddress(mailPage, "emailnator");
    log(`temp-почта (${a.kind}): ${a.addr}`);

    await page.fill('input[name="email_address"]', a.addr);
    await page.click('button:has-text("Email me a code"), input[type="submit"][value="Email me a code"], input[type="submit"][name="commit"]');
    await page.waitForURL(/session\/code/, { timeout: 30000 });
    log("ждём 6-значный код…");

    // первый код может не доехать — тогда жмём "Send a new code" и ждём ещё раз
    let msg = null;
    try {
      msg = await waitMessage(mailPage, /slice\.video/i, 120000);
    } catch (first) {
      log("первое письмо не пришло — запрашиваю код заново");
      await page.click('a:has-text("Send a new code"), button:has-text("Send a new code")', { timeout: 10000 })
        .catch(() => {});
      msg = await waitMessage(mailPage, /slice\.video/i, 150000);
    }
    const code = extractCode(msg.text);
    if (!code) throw new Error("slice: код не найден в письме");
    log(`код ${code}`);

    await page.fill('input#code, input[name="code"], input[placeholder="123456"], input[placeholder="6-digit code"]', code);
    await page.click('input[type="submit"][name="commit"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")', { timeout: 10000 })
      .catch(async () => page.keyboard.press("Enter"));
    await page.waitForURL(/videos/, { timeout: 30000 });
    log("аккаунт создан");
  } finally {
    await mailPage.close().catch(() => {});
  }
}

export { PASSWORD };
