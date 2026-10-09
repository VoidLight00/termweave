import { expect, it } from "bun:test";
import { secretPrompt, validSecret } from "./secret-prompt.ts";

it("recognizes only a short secret request on the last nonempty line", () => {
  for (const prompt of ["[sudo] password for alice:", "alice@server's password:", "Password:", "Password for alice:", "Enter passphrase:", "Enter passphrase for key '/tmp/key':", "Enter PIN:", "Enter PIN for token:", "Repeat password:", "Verify password:", "Confirm password:"]) {
    expect(secretPrompt(`previous output\r\n ${prompt} \r\n\n`)).toBe(prompt);
  }
  for (const screen of ["", "Password?", "Password: y/n", "Enter PIN for y/n:", "Please enter your password:", "Example: Password:", "Password:\n$ ", `Password for ${"x".repeat(120)}:`]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});

it("rejects multiline and terminal-control secrets while preserving spaces and Unicode", () => {
  expect(validSecret("  한글🔒  ")).toBe(true);
  for (const value of [null, "", "x".repeat(4097), "one\ntwo", "one\rtwo", "\u001b[200~", "\u0003", "\u007f", "\u009b"]) expect(validSecret(value)).toBe(false);
});

it("joins only right-edge continuations of a narrow prompt", () => {
  expect(secretPrompt("Enter passphrase for key '/tmp/my private key for testing\n':\n", 57)).toBe("Enter passphrase for key '/tmp/my private key for testing':");
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", "Enter passphrase for key ".length)).toBe("Enter passphrase for key '/tmp/key':");
  expect(secretPrompt("Enter passphrase for key\n '/tmp/key':", "Enter passphrase for key".length)).toBe("Enter passphrase for key '/tmp/key':");
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", 80)).toBeNull();
  expect(secretPrompt("This is prose that ends\nPassword?", 24)).toBeNull();
});
