import type { ReactNode, Ref } from 'react';
import ThemeMenu from './shell/ThemeMenu';

interface AuthCanvasProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Reaches the `<h1>` directly, not typed by any HTML attributes interface since this wraps one
   * rather than being one — LoginPage moves focus here when its mode toggle swaps the form, so the
   * change is announced without a second render pass to look the heading up afterwards. */
  ref?: Ref<HTMLHeadingElement>;
}

/**
 * The shell-less frame for the two pages an anonymous visitor can reach — no sidebar, no topbar,
 * so this draws the page's entire visual frame rather than sitting inside `.container`. Anatomy is
 * fixed rather than composable: a brand lockup (the one in-content brand moment in the app), a
 * bordered card holding `children`, and an optional footer for the page's one secondary path.
 */
export default function AuthCanvas({ title, description, children, footer, ref }: AuthCanvasProps) {
  return (
    <div className="auth-view">
      <div className="auth-canvas">
        <div className="auth-theme">
          <ThemeMenu />
        </div>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-wordmark">Evidence Ops</span>
        </div>
        <section className="card card--auth">
          <h1 className="page-title" tabIndex={-1} ref={ref}>
            {title}
          </h1>
          {description && <p className="page-sub">{description}</p>}
          {children}
        </section>
        {footer && <div className="auth-alt">{footer}</div>}
      </div>
    </div>
  );
}
