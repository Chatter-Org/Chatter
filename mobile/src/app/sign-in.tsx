import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Linking, Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { LOGIN_CONNECTION_STEPS } from "@chatter/core/loginScreen";
import { useChatterActions } from "@/state/ChatterProvider";
import { currentServer, normalizeServer, setServer } from "@/platform/server";
import { CrtBackground, type CrtClearance } from "@/components/CrtBackground";

/**
 * Sign in — the web's LoginScreen: a terminal card over the CRT backdrop,
 * in its own fixed palette rather than the theme's, as on the web. The phone
 * adds the server to connect to; creating an account and recovering one open
 * the web, where the authenticator is set up.
 */

// LoginScreen's palette.
const C = {
  title: "rgba(220, 230, 255, 0.95)",
  text: "rgba(220, 230, 255, 0.85)",
  dim: "rgba(180, 210, 255, 0.4)",
  faint: "rgba(180, 210, 255, 0.35)",
  link: "rgba(180, 210, 255, 0.5)",
  border: "rgba(180, 210, 255, 0.12)",
  rule: "rgba(180, 210, 255, 0.1)",
  caret: "rgba(180, 210, 255, 0.6)",
  error: "rgba(255, 120, 100, 0.8)",
  ok: "rgba(120, 230, 160, 0.9)",
};
const MONO = "JetBrainsMono_400Regular";
const MONO_BOLD = "JetBrainsMono_700Bold";

export default function SignIn() {
  const { signIn } = useChatterActions();
  const insets = useSafeAreaInsets();
  const [server, setServerText] = useState(currentServer());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [card, setCard] = useState<CrtClearance | undefined>();
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);
  const codeRef = useRef<ComponentRef<typeof TextInput>>(null);

  // The connection sequence plays while the request is out (its first step
  // shows with the request, in submit). It never holds the reader up: an
  // answer that comes first skips to the end.
  useEffect(() => {
    if (!busy) return;
    const timers = LOGIN_CONNECTION_STEPS.slice(1, -1).map((s, i) => setTimeout(() => setSteps(i + 2), s.ms));
    return () => timers.forEach(clearTimeout);
  }, [busy]);

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
      setError("enter your username and password.");
      return;
    }
    if (needsCode && code.trim().length < 6) {
      setError("enter the 6-digit code from your authenticator.");
      return;
    }
    setBusy(true);
    setSteps(1);
    try {
      setServer(origin);
      const result = await signIn(username.trim(), password, needsCode ? code.trim() : undefined);
      if (result.requiresTotp) {
        setNeedsCode(true);
        setTimeout(() => codeRef.current?.focus(), 50);
      } else {
        setSteps(LOGIN_CONNECTION_STEPS.length);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const openWeb = () => {
    try {
      void Linking.openURL(normalizeServer(server));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const subtitle = busy ? "authenticating..." : needsCode ? "enter authenticator code" : "what will you chat about?";
  const version = Constants.expoConfig?.version ?? "0.1.0";

  return (
    <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
      <CrtBackground clear={card} />
      <KeyboardAwareScrollView
        bottomOffset={130}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }}
      >
        <View
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            setCard({ top: y, bottom: y + height });
          }}
          style={{
            width: "100%",
            maxWidth: 448,
            alignSelf: "center",
            borderRadius: 13.4,
            borderWidth: 1,
            borderColor: busy ? `rgba(180, 210, 255, ${0.15 + (steps / LOGIN_CONNECTION_STEPS.length) * 0.45})` : "rgba(180, 210, 255, 0.15)",
            backgroundColor: "rgba(10, 10, 10, 0.92)",
            boxShadow: "0 0 20px rgba(180, 210, 255, 0.04)",
            overflow: "hidden",
          }}
        >
          <View style={{ paddingHorizontal: 26, paddingTop: 26 }}>
            <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 3.3, textTransform: "uppercase", color: C.faint, marginBottom: 35 }}>
              v{version} - mobile build
            </Text>
            <Text
              adjustsFontSizeToFit
              numberOfLines={1}
              style={{ fontFamily: MONO_BOLD, fontSize: 53, letterSpacing: 5.3, textTransform: "uppercase", color: C.title, textAlign: "center" }}
            >
              Chatter
            </Text>
            <Text style={{ fontFamily: MONO, fontSize: 13.2, letterSpacing: 1.05, color: C.dim, textAlign: "center", marginTop: 13 }}>{subtitle}</Text>
            <View style={{ height: 1, backgroundColor: C.rule, marginTop: 17.6 }} />
          </View>

          <View style={{ paddingHorizontal: 26, paddingTop: 22, paddingBottom: 26, gap: 22 }}>
            {busy ? (
              <Sequence shown={steps} />
            ) : (
              <>
                <Field
                  label="server"
                  value={server}
                  onChangeText={setServerText}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  textContentType="URL"
                  editable={!needsCode}
                />
                <Field
                  label="username"
                  value={username}
                  onChangeText={(t) => setUsername(t.replace(/[^A-Za-z0-9_]/g, ""))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="username"
                  textContentType="username"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  editable={!needsCode}
                />
                <Field
                  label="password"
                  inputRef={passwordRef}
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (error) setError(null);
                  }}
                  secureTextEntry
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType={needsCode ? "next" : "go"}
                  onSubmitEditing={() => (needsCode ? codeRef.current?.focus() : void submit())}
                  editable={!needsCode}
                  spacing={2.6}
                />
                {needsCode ? (
                  <Field
                    label="authenticator code"
                    inputRef={codeRef}
                    value={code}
                    onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    placeholder="000000"
                    returnKeyType="go"
                    onSubmitEditing={() => void submit()}
                    spacing={5}
                    center
                  />
                ) : null}

                {error ? (
                  <View style={{ padding: 13, borderWidth: 1, borderColor: "rgba(255, 120, 100, 0.25)", backgroundColor: "rgba(255, 120, 100, 0.05)" }}>
                    <Text style={{ fontFamily: MONO, fontSize: 12.1, letterSpacing: 1, textTransform: "uppercase", color: C.error }}>&gt; {error}</Text>
                  </View>
                ) : null}

                <Pressable
                  onPress={submit}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    height: 44,
                    borderRadius: 13.4,
                    borderWidth: 1,
                    borderColor: pressed ? "rgba(180, 210, 255, 0.4)" : "rgba(180, 210, 255, 0.2)",
                    backgroundColor: pressed ? "rgba(180, 210, 255, 0.1)" : "rgba(180, 210, 255, 0.04)",
                    alignItems: "center",
                    justifyContent: "center",
                  })}
                >
                  <Text style={{ fontFamily: MONO, fontSize: 13.2, letterSpacing: 2.6, textTransform: "uppercase", color: "rgba(220, 230, 255, 0.8)" }}>connect</Text>
                </Pressable>

                <View style={{ flexDirection: "row", justifyContent: "center", gap: 17.6, paddingTop: 4 }}>
                  {needsCode ? (
                    <Link
                      text="use a different account"
                      onPress={() => {
                        setNeedsCode(false);
                        setCode("");
                      }}
                    />
                  ) : (
                    <>
                      <Link text="create account" onPress={openWeb} />
                      <Link text="forgot password?" onPress={openWeb} />
                    </>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </KeyboardAwareScrollView>

      {/* The web's "?" in the corner. */}
      {help ? (
        <View
          style={{
            position: "absolute",
            right: 20,
            bottom: insets.bottom + 64,
            maxWidth: 240,
            padding: 10,
            borderRadius: 13.4,
            borderWidth: 1,
            borderColor: "rgba(180, 210, 255, 0.2)",
            backgroundColor: "rgba(10, 10, 10, 0.95)",
          }}
        >
          <Text style={{ fontFamily: MONO_BOLD, fontSize: 12.1, color: "rgba(220, 230, 255, 0.9)", marginBottom: 4 }}>Chatter</Text>
          <Text style={{ fontFamily: MONO, fontSize: 12.1, lineHeight: 19, color: "rgba(220, 230, 255, 0.75)" }}>
            A lightweight self-hosted chat app. Create an account, set up two-factor authentication, and start chatting. Voice, text,
            reactions -- all in real time.
          </Text>
        </View>
      ) : null}
      <Pressable
        onPress={() => setHelp((h) => !h)}
        accessibilityRole="button"
        accessibilityLabel="About Chatter"
        style={{
          position: "absolute",
          right: 20,
          bottom: insets.bottom + 20,
          width: 36,
          height: 36,
          borderRadius: 13.4,
          borderWidth: 1,
          borderColor: help ? "rgba(180, 210, 255, 0.35)" : "rgba(180, 210, 255, 0.15)",
          backgroundColor: "rgba(10, 10, 10, 0.6)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontFamily: MONO, fontSize: 13.2, color: help ? "rgba(220, 230, 255, 0.8)" : "rgba(180, 210, 255, 0.4)" }}>?</Text>
      </Pressable>
    </View>
  );
}

function Field({
  label,
  inputRef,
  spacing = 1,
  center,
  ...props
}: TextInputProps & { label: string; inputRef?: React.Ref<ComponentRef<typeof TextInput>>; spacing?: number; center?: boolean }) {
  return (
    <View style={{ gap: 6.6 }}>
      <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2.2, textTransform: "uppercase", color: C.dim }}>{label}</Text>
      <TextInput
        ref={inputRef}
        placeholder=">"
        placeholderTextColor="rgba(180, 210, 255, 0.3)"
        accessibilityLabel={label}
        cursorColor={C.caret}
        selectionColor="rgba(180, 210, 255, 0.3)"
        {...props}
        style={{
          height: 44,
          borderRadius: 13.4,
          borderWidth: 1,
          borderColor: C.border,
          paddingHorizontal: 13,
          fontFamily: MONO,
          fontSize: 15.4,
          letterSpacing: spacing,
          color: C.text,
          textAlign: center ? "center" : "left",
          opacity: props.editable === false ? 0.6 : 1,
        }}
      />
    </View>
  );
}

function Link({ text, onPress }: { text: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      {({ pressed }) => (
        <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.65, textTransform: "uppercase", color: pressed ? "rgba(180, 210, 255, 0.85)" : C.link }}>
          {text}
        </Text>
      )}
    </Pressable>
  );
}

/** The terminal lines while signing in, with the progress rule under them. */
function Sequence({ shown }: { shown: number }) {
  const total = LOGIN_CONNECTION_STEPS.length;
  return (
    <View style={{ minHeight: 158, gap: 4.4 }}>
      {LOGIN_CONNECTION_STEPS.map((s, i) => {
        const visible = i < shown;
        const last = i === total - 1;
        return (
          <View key={s.text} style={{ flexDirection: "row", gap: 8.8, opacity: visible ? 1 : 0 }}>
            <Text style={{ fontFamily: MONO, fontSize: 12.1, color: last ? "rgba(120, 230, 160, 0.6)" : "rgba(180, 210, 255, 0.3)" }}>{last ? "✓" : ">"}</Text>
            <Text style={{ fontFamily: MONO, fontSize: 12.1, letterSpacing: 0.6, color: last ? C.ok : "rgba(200, 220, 255, 0.75)" }}>
              {s.text}
              {i === shown - 1 && !last ? <Text style={{ color: "rgba(180, 210, 255, 0.6)" }}> ▌</Text> : null}
            </Text>
          </View>
        );
      })}
      <View style={{ marginTop: 17.6, height: 1, backgroundColor: "rgba(180, 210, 255, 0.08)" }}>
        <View style={{ height: 1, width: `${(shown / total) * 100}%`, backgroundColor: "rgba(180, 210, 255, 0.4)" }} />
      </View>
    </View>
  );
}
