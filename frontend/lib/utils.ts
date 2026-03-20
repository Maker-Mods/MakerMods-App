import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名，与 shadcn/ui 组件兼容。
 * 使用 clsx 处理条件类名，twMerge 解决 Tailwind 冲突。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
