import type { InputHTMLAttributes, ReactNode } from "react";
import s from "./Input.module.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** 右侧挂件（单位、提交提示） */
  suffix?: ReactNode;
  /** 等宽（串口手动输入、波特率） */
  mono?: boolean;
  size?: "sm" | "md";
}

/** 文本输入（§15.3）。串口手动输入与波特率自定都用它。 */
export function Input({ suffix, mono, size = "sm", className, ...rest }: InputProps) {
  return (
    <span className={[s.wrap, className].filter(Boolean).join(" ")}>
      <input
        {...rest}
        className={[s.input, mono ? s.mono : "", s[size]].filter(Boolean).join(" ")}
      />
      {suffix ? <span className={s.suffix}>{suffix}</span> : null}
    </span>
  );
}
