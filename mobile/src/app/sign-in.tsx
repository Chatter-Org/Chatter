import { useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChatterActions } from "@/state/ChatterProvider";
import { currentServer, normalizeServer, setServer } from "@/platform/server";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * Sign in: server, username and password, then the authenticator code when
 * the account has one. Creating an account and recovering one stay on the
 * web, where the authenticator is set up.
 */
export default function SignIn() {
  const { signIn } = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [server, setServerText] = useState(currentServer());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);
  const codeRef = useRef<ComponentRef<typeof TextInput>>(null);

  const submit = async () => {
    if (busy) return;
    setError(null);
    let origin: string;
    try {
      origin = normalizeServer(server);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    if (needsCode && code.trim().length < 6) {
      setError("Enter the 6-digit code from your authenticator.");
      return;
    }
    setBusy(true);
    try {
      setServer(origin);
      const result = await signIn(username.trim(), password, needsCode ? code.trim() : undefined);
      if (result.requiresTotp) {
        setNeedsCode(true);
        setTimeout(() => codeRef.current?.focus(), 50);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const field = (props: React.ComponentProps<typeof TextInput>, label: string) => (
    <View className="gap-1.5">
      <T className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</T>
      <TextInput
        {...props}
        placeholderTextColor={colors["muted-foreground"]}
        className="rounded-lg border border-input bg-card px-3.5 py-3 font-mono text-[15px] text-foreground"
      />
    </View>
  );

  return (
    <KeyboardAwareScrollView
      // Room for the Connect button below the focused field.
      bottomOffset={130}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
      className="bg-background"
    >
      <View className="w-full max-w-[420px] self-center gap-5 px-6">
        <View className="items-center gap-1 pb-4">
          <T className="font-mono-bold text-3xl tracking-[6px]">chatter</T>
          <T className="text-xs text-muted-foreground">{needsCode ? "enter your authenticator code" : "sign in to continue"}</T>
        </View>
        {field(
          {
            value: server,
            onChangeText: setServerText,
            autoCapitalize: "none",
            autoCorrect: false,
            keyboardType: "url",
            textContentType: "URL",
            editable: !needsCode,
            accessibilityLabel: "Server",
          },
          "Server",
        )}
        {field(
          {
            value: username,
            onChangeText: setUsername,
            autoCapitalize: "none",
            autoCorrect: false,
            autoComplete: "username",
            textContentType: "username",
            returnKeyType: "next",
            onSubmitEditing: () => passwordRef.current?.focus(),
            editable: !needsCode,
            accessibilityLabel: "Username",
          },
          "Username",
        )}
        {field(
          {
            ref: passwordRef,
            value: password,
            onChangeText: setPassword,
            secureTextEntry: true,
            autoComplete: "current-password",
            textContentType: "password",
            returnKeyType: needsCode ? "next" : "go",
            onSubmitEditing: () => (needsCode ? codeRef.current?.focus() : void submit()),
            editable: !needsCode,
            accessibilityLabel: "Password",
          },
          "Password",
        )}
        {needsCode &&
          field(
            {
              ref: codeRef,
              value: code,
              onChangeText: (t) => setCode(t.replace(/\D/g, "").slice(0, 6)),
              keyboardType: "number-pad",
              autoComplete: "one-time-code",
              textContentType: "oneTimeCode",
              placeholder: "000000",
              returnKeyType: "go",
              onSubmitEditing: () => void submit(),
              accessibilityLabel: "Authenticator code",
            },
            "Authenticator code",
          )}
        {error ? <T className="text-sm text-destructive">{error}</T> : null}
        <Pressable
          onPress={submit}
          disabled={busy}
          accessibilityRole="button"
          className={cn("mt-1 items-center rounded-lg bg-primary py-3.5", busy && "opacity-60")}
        >
          {busy ? <ActivityIndicator color={colors["primary-foreground"]} /> : <T className="font-mono-bold uppercase tracking-widest text-primary-foreground">Connect</T>}
        </Pressable>
        {needsCode ? (
          <Pressable onPress={() => { setNeedsCode(false); setCode(""); }} className="items-center py-2">
            <T className="text-xs text-muted-foreground">use a different account</T>
          </Pressable>
        ) : (
          <T className="text-center text-xs text-muted-foreground">New here? Create an account on the web first.</T>
        )}
      </View>
    </KeyboardAwareScrollView>
  );
}
