// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNotSetUpNotice, signInErrorMessage } from "../../lib/auth-config";
import { SignInPage } from "./SignInPage";

afterEach(cleanup);
const action = vi.fn(async () => undefined);

describe("SignInPage: the 'not set up' notice is a state, not a failure", () => {
  it("shows the not-set-up wording as an explanation and never as a red 'did not finish' alert, in both the old and the new wording", () => {
    for (const error of ["Google sign-in is not set up on this server yet.", "Sign-in is not set up on this server yet."]) {
      const { unmount } = render(<SignInPage action={action} error={error} callbackUrl="/" configured={false} />);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Sign-in did not finish")).toBeNull();
      expect(screen.getByText("Google sign-in is not set up yet")).toBeTruthy();
      unmount();
    }
  });
  it("still shows a real failure as an alert", () => {
    render(<SignInPage action={action} error="Wrong email or password. Please try again." callbackUrl="/" configured emailEnabled />);
    expect(screen.getByRole("alert").textContent).toMatch(/Wrong email or password/);
  });
  it("recognises exactly the not-set-up notices", () => {
    expect(isNotSetUpNotice("Sign-in is not set up on this server yet.")).toBe(true);
    expect(isNotSetUpNotice("Google sign-in is not set up on this server yet.")).toBe(true);
    expect(isNotSetUpNotice(signInErrorMessage("NotConfigured"))).toBe(true);
    for (const other of [null, undefined, "", "Wrong email or password. Please try again.", "Too many attempts. Please wait a few minutes and try again.", "Signing in with Google did not finish. Please try again."]) expect(isNotSetUpNotice(other), String(other)).toBe(false);
  });
});

describe("SignInPage: the email form only where email sign-in can work", () => {
  it("is offered by default and when enabled, with the password length limits", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/" configured emailEnabled />);
    expect(screen.getByLabelText("Email")).toBeTruthy();
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect([pw.minLength, pw.maxLength]).toEqual([8, 128]);
    expect(screen.getByRole("button", { name: "Sign in with email" })).toBeTruthy();
    expect(screen.getByText(/Sign in with Google or use an email and password/)).toBeTruthy();
  });
  it("is not offered, and nothing promises it, when it cannot work", () => {
    render(<SignInPage action={action} error="Sign-in is not set up on this server yet." callbackUrl="/" configured={false} emailEnabled={false} />);
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: /email/i })).toBeNull();
    expect(screen.queryByText(/use email and password below/i)).toBeNull();
    expect(screen.getByText(/signing in is unavailable right now/)).toBeTruthy();
    expect(screen.getByText(/search for medicines without an account/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("with Google set up but email not, offers Google only", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/" configured emailEnabled={false} />);
    expect(screen.getByRole("button", { name: /Google/ })).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByText(/Sign in with Google\./)).toBeTruthy();
  });
  it("with Google not set up but email working, says to use email below", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/" configured={false} emailEnabled />);
    expect(screen.getByText(/You can still use email and password below/)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});

describe("sign-in error wording", () => {
  it("has plain words for the new outcomes and keeps the existing ones", () => {
    expect(signInErrorMessage("TooManyAttempts")).toMatch(/Too many attempts/);
    expect(signInErrorMessage("Unavailable")).toMatch(/temporarily unavailable/);
    expect(signInErrorMessage("EmailTaken")).toMatch(/already exists/);
    expect(signInErrorMessage("CredentialsSignin")).toMatch(/Wrong email or password/);
    expect(signInErrorMessage("anything-crafted<script>")).not.toMatch(/crafted|script/);
  });
});
