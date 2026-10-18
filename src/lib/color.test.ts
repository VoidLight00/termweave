import { describe, expect, it } from "bun:test";
import { hexToRgb, hsvToHex, hsvToRgb, rgbToHex, rgbToHsv } from "./color.ts";

describe("color conversions", () => {
  it("parses and prints hex", () => {
    expect(hexToRgb("#f0a830")).toEqual({ r: 240, g: 168, b: 48 });
    expect(hexToRgb("fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb("red")).toBeNull();
    expect(rgbToHex({ r: 240, g: 168, b: 48 })).toBe("#f0a830");
    expect(rgbToHex({ r: 300, g: -4, b: 0.4 })).toBe("#ff0000");
  });
  it("maps primaries and greys to HSV", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, v: 100 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
    expect(hsvToRgb({ h: 360, s: 100, v: 100 })).toEqual({ r: 255, g: 0, b: 0 });
  });
  it("round-trips every theme default through HSV", () => {
    for (const hex of ["#12100e", "#181613", "#d8d0c3", "#f0a830", "#3e3830", "#000000", "#ffffff", "#cba6f7"]) {
      expect(hsvToHex(rgbToHsv(hexToRgb(hex)!))).toBe(hex);
    }
  });
});
