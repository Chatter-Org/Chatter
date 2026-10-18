import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { useChatter } from "@/state/ChatterProvider";
import { T } from "@/ui/primitives";

/**
 * Holds the app behind a quiet screen while a saved session is being
 * restored, so someone who is signed in never sees the sign-in form flash —
 * and says so plainly when the server cannot be reached rather than signing
 * them out.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { sessionRestore } = useChatter();
  if (sessionRestore === "pending" || sessionRestore === "unreachable") {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-8">
        <T className="font-mono-bold text-2xl tracking-widest">chatter</T>
        <ActivityIndicator />
        {sessionRestore === "unreachable" ? (
          <T className="text-center text-xs text-muted-foreground">Can't reach the server. Trying again…</T>
        ) : null}
      </View>
    );
  }
  return <>{children}</>;
}
