/**
 * Mock 数据，仅在 USE_MOCK=true 时由 services 使用。
 * 用于本地开发无后端时的占位，保证构建能解析该模块。
 */
import type { PortInfo, CameraInfo, StartResponse } from "./wizard-types";

export const ports: PortInfo[] = [];
export const cameras: CameraInfo[] = [];
export const calibrationFiles: Record<string, string[]> = {};

export function startResponse(
  _type: "calibration" | "teleoperation" | "recording"
): StartResponse {
  return { process_id: "mock", message: "Mock mode" };
}
