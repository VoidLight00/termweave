import { Component, type ReactNode } from "react";

/**
 * Keeps a render error inside the part of the page that threw it. React unmounts the whole
 * tree on an uncaught render error, so one transcript entry the chat cannot draw would
 * otherwise leave the app blank. A change of `resetKey` (new data, another pane) tries again,
 * in the same render: a fallback committed first would let the chat keep its scroll for the
 * short fallback, not for what replaced it.
 */
interface Props {
  resetKey: unknown;
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

interface State { failed: boolean; key: unknown }

export class RenderBoundary extends Component<Props, State> {
  override state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("render failed", error);
  }

  private retry = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
