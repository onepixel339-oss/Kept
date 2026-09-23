/**
 * Account validation — the only definitions of what an email, a
 * password, and a password change look like.
 *
 * Password policy is deliberately reasonable: at least 8 characters,
 * at most 200, and nothing else. No composition theater — length is
 * what actually protects people. Requirements are stated honestly in
 * the UI ("At least 8 characters").
 */

import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "An email address is required.")
  .max(254, "That email address is too long.")
  .email("That doesn't look like an email address.");

export const passwordSchema = z
  .string()
  .min(8, "Passwords need at least 8 characters.")
  .max(200, "That password is too long.");

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "A password is required.").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: passwordSchema,
});

export const resetRequestSchema = z.object({
  email: emailSchema,
});

export const resetConfirmSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: passwordSchema,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetRequestInput = z.infer<typeof resetRequestSchema>;
export type ResetConfirmInput = z.infer<typeof resetConfirmSchema>;
