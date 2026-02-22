"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useSession } from "../hooks/use-session";
import { cn } from "../lib/utils";
import { useAuthContext } from "./auth-provider";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const profileSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Please enter a valid email address"),
});

type ProfileFormValues = z.infer<typeof profileSchema>;

export type UserProfileProps = {
  className?: string;
  classNames?: {
    card?: string;
    avatar?: string;
    saveButton?: string;
    cancelButton?: string;
    input?: string;
  };
};

export function UserProfile({ className, classNames }: UserProfileProps) {
  const { client } = useAuthContext();
  const { data, isPending } = useSession();
  const router = useRouter();

  const user = data?.user;

  const [editingField, setEditingField] = React.useState<
    "name" | "email" | null
  >(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(
    null
  );
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name ?? "",
      email: user?.email ?? "",
    },
  });

  // Redirect to sign-in if no session (and not loading)
  const hasRedirected = React.useRef(false);
  React.useEffect(() => {
    if (!isPending && !user && !hasRedirected.current) {
      hasRedirected.current = true;
      router.push("/sign-in");
    }
  }, [isPending, user, router]);

  const startEditing = (field: "name" | "email") => {
    reset({
      name: user?.name ?? "",
      email: user?.email ?? "",
    });
    setSuccessMessage(null);
    setServerError(null);
    setEditingField(field);
  };

  const cancelEditing = () => {
    setEditingField(null);
    setServerError(null);
  };

  const onSubmit = async (values: ProfileFormValues) => {
    setServerError(null);
    setSuccessMessage(null);
    try {
      const payload: Record<string, string> = {};
      if (editingField === "name") payload.name = values.name;
      if (editingField === "email") payload.email = values.email;

      const result = await (client as Record<string, Function>).updateUser(
        payload
      );

      if (result?.error) {
        setServerError("Something went wrong. Please try again.");
        return;
      }

      setSuccessMessage("Profile updated successfully.");
      setEditingField(null);
    } catch {
      setServerError("Something went wrong. Please try again.");
    }
  };

  if (!user && !isPending) {
    return null;
  }

  const initials = user?.name ? user.name.charAt(0).toUpperCase() : "?";

  return (
    <div className={cn("w-full max-w-md", className, classNames?.card)}>
      {/* Avatar */}
      <div className="flex justify-center mb-4">
        <Avatar className={classNames?.avatar}>
          {user?.image ? (
            <AvatarImage
              src={user.image as string}
              alt={user.name ?? "User avatar"}
            />
          ) : null}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </div>

      {successMessage && (
        <p role="status" className="text-sm text-green-600 mb-2">
          {successMessage}
        </p>
      )}

      {serverError && (
        <p role="alert" className="text-sm text-destructive mb-2">
          {serverError}
        </p>
      )}

      {/* Name field */}
      <div className="mb-4">
        {editingField === "name" ? (
          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="space-y-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                type="text"
                autoComplete="name"
                className={classNames?.input}
                {...register("name")}
              />
              {errors.name && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <Button
                type="submit"
                disabled={isSubmitting}
                aria-disabled={isSubmitting}
                aria-label="Save"
                className={classNames?.saveButton}
              >
                {isSubmitting ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={cancelEditing}
                className={classNames?.cancelButton}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="text-left w-full cursor-pointer hover:underline"
            onClick={() => startEditing("name")}
          >
            {user?.name}
          </button>
        )}
      </div>

      {/* Email field */}
      <div className="mb-4">
        {editingField === "email" ? (
          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                autoComplete="email"
                className={classNames?.input}
                {...register("email")}
              />
              {errors.email && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <Button
                type="submit"
                disabled={isSubmitting}
                aria-disabled={isSubmitting}
                aria-label="Save"
                className={classNames?.saveButton}
              >
                {isSubmitting ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={cancelEditing}
                className={classNames?.cancelButton}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="text-left w-full cursor-pointer hover:underline"
            onClick={() => startEditing("email")}
          >
            {user?.email}
          </button>
        )}
      </div>
    </div>
  );
}
UserProfile.displayName = "UserProfile";
