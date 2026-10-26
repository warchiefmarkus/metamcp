const exampleEmails = new Set([
  "admin@local.test",
  "test@user.example",
  "admin@example.com",
  "root@localhost",
  "admin@localhost",
  "you@yourdomain.com",
  "you@example.com",
  "your@email.com",
]);

export type BootstrapAccount = { email?: unknown; password?: unknown };

export function assertSecureBootstrapCredentials(
  env: Record<string, string | undefined>,
): void {
  const users: BootstrapAccount[] = [];

  if (env.BOOTSTRAP_USERS?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.BOOTSTRAP_USERS);
    } catch {
      throw new Error("Invalid BOOTSTRAP_USERS JSON; refusing unsafe bootstrap.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("BOOTSTRAP_USERS must be an array.");
    }
    users.push(...parsed);
  }

  const email = env.BOOTSTRAP_USER_EMAIL?.trim();
  const password = env.BOOTSTRAP_USER_PASSWORD;
  if (Boolean(email) !== Boolean(password)) {
    throw new Error(
      "BOOTSTRAP_USER_EMAIL and BOOTSTRAP_USER_PASSWORD must both be set or both be unset.",
    );
  }
  if (email && password) users.push({ email, password });

  for (const user of users) {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      throw new Error("Malformed BOOTSTRAP_USERS account; refusing bootstrap.");
    }
    const userEmail = typeof user.email === "string" ? user.email.trim() : "";
    const userPassword = typeof user.password === "string" ? user.password : "";
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail) ||
      exampleEmails.has(userEmail.toLowerCase()) ||
      userEmail.endsWith(".example") ||
      userEmail.endsWith(".test")
    ) {
      throw new Error(
        "Bootstrap user email is missing, invalid, or a sample/default address.",
      );
    }
    if (
      userPassword.length < 20 ||
      userPassword.length > 128 ||
      userPassword !== userPassword.trim() ||
      new Set(userPassword).size < 8 ||
      /(.)\1{7,}/u.test(userPassword) ||
      /password|changeme|letmein|qwerty|12345678|admin123|replace[-_]?with|placeholder|example|sample|default/i.test(userPassword) ||
      [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((p) => p.test(userPassword))
        .length < 2
    ) {
      // Never include the password itself in errors/logs.
      throw new Error(
        "Unsafe BOOTSTRAP_USER_PASSWORD / BOOTSTRAP_USERS credential. Require a unique 20–128 character password; default or weak credentials are forbidden.",
      );
    }
  }
}
