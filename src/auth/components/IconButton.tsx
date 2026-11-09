import { useEffect, useId, useRef, useState } from 'react';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { getOrbitAction, type OrbitActionId } from '../actionRegistry';
import { OrbitIcon } from './OrbitIcon';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children' | 'title'> {
  action: OrbitActionId;
  label?: string;
  pressed?: boolean;
  loading?: boolean;
  showLabel?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  action,
  label,
  pressed,
  loading = false,
  showLabel = false,
  className = '',
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
  onKeyDown,
  ...props
}: IconButtonProps, ref) {
  const definition = getOrbitAction(action);
  const accessibleLabel = label ?? definition.label;
  const tooltipId = useId();
  const timer = useRef<number | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const showTooltip = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTooltipVisible(true), 300);
  };
  const hideTooltip = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setTooltipVisible(false);
  };
  return <button
    ref={ref}
    {...props}
    type={props.type ?? 'button'}
    className={`orbit-icon-button${showLabel ? ' has-visible-label' : ''}${className ? ` ${className}` : ''}`}
    data-tone={definition.tone}
    aria-label={accessibleLabel}
    aria-pressed={pressed}
    aria-busy={loading || undefined}
    aria-describedby={tooltipId}
    onFocus={(event) => { onFocus?.(event); showTooltip(); }}
    onBlur={(event) => { onBlur?.(event); hideTooltip(); }}
    onMouseEnter={(event) => { onMouseEnter?.(event); showTooltip(); }}
    onMouseLeave={(event) => { onMouseLeave?.(event); hideTooltip(); }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.key === 'Escape') hideTooltip();
    }}
  >
    <OrbitIcon name={loading ? 'loading' : definition.icon} size={18} />
    <span className="orbit-icon-button-label">{accessibleLabel}</span>
    <span id={tooltipId} role="tooltip" className={`orbit-tooltip${tooltipVisible ? ' is-visible' : ''}`}>
      {definition.shortcut ? `${accessibleLabel} · ${definition.shortcut}` : accessibleLabel}
    </span>
  </button>;
});
