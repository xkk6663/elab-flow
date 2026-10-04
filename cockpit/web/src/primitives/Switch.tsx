import s from "./Switch.module.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  /** 右侧说明文字（小一号、弱色） */
  hint?: string;
  disabled?: boolean;
  id?: string;
}

/** 36×20 开关（§15.3）。用原生 checkbox 承载语义，视觉由 CSS 画。 */
export function Switch({ checked, onChange, label, hint, disabled, id }: SwitchProps) {
  return (
    <label className={s.row} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className={s.input}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className={s.track} aria-hidden="true">
        <span className={s.knob} />
      </span>
      {label ? <span className={s.label}>{label}</span> : null}
      {hint ? <span className={s.hint}>{hint}</span> : null}
    </label>
  );
}
