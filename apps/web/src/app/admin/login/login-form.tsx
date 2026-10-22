"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

import { login, type LoginError, type LoginState } from "./actions";

export type LoginFormText = {
  email: string;
  password: string;
  submit: string;
  submitting: string;
  errors: Record<LoginError, string>;
};

const initialState: LoginState = { error: null, email: "" };

/** The form posts to the login server action; the tokens never reach this component. */
export function LoginForm({ text }: { text: LoginFormText }) {
  const [state, action, pending] = useActionState(login, initialState);
  const error = state.error ? text.errors[state.error] : null;

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{text.email}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{text.password}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
        />
      </div>
      {error ? (
        <p id="login-error" role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="mt-2 w-full">
        {pending ? text.submitting : text.submit}
      </Button>
    </form>
  );
}
