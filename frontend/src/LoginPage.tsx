import { FormEvent, useState } from 'react';
import { OfficeIcon } from './components/OfficeIcon';

type LoginPageProps = {
  loading: boolean;
  error: string;
  onLogin: (password: string) => Promise<void>;
};

export function LoginPage({ loading, error, onLogin }: LoginPageProps) {
  const [password, setPassword] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || password.length < 12) return;
    await onLogin(password);
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          <OfficeIcon name="office" size={24} />
        </div>
        <p className="login-kicker">HERMES OFFICE</p>
        <h1 id="login-title">回到你的智能办公室</h1>
        <p className="login-copy">这是私人工作空间。请输入办公室密码后继续。</p>

        <form className="login-form" onSubmit={handleSubmit} aria-busy={loading}>
          <label htmlFor="office-password">办公室密码</label>
          <input
            id="office-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            minLength={12}
            maxLength={256}
            required
            autoFocus
            disabled={loading}
          />
          <small>密码至少 12 个字符，仅用于本地验证。</small>
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={loading || password.length < 12}>
            {loading ? '正在验证…' : '进入办公室'}
          </button>
        </form>

        <p className="login-recovery">
          忘记密码时，通过 Tailscale SSH 在服务器上重设；网页没有绕过入口。
        </p>
      </section>
    </main>
  );
}
