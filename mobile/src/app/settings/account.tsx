import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy, ExternalLink, LogOut, ShieldCheck, Smartphone } from "lucide-react-native";
import {
  apiChangePassword,
  apiGetRecoveryCodes,
  apiGetSessions,
  apiRevokeSession,
  apiSetupTotp,
  type SessionInfo,
} from "@chatter/core/api";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Button } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING } from "@/ui/roles";
import { SettingsSection, TextField } from "@/ui/settings";

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * The account — the web profile dialog's Account tab: two-factor, recovery
 * codes, the password, where you are signed in, and deleting it all. Every
 * change that matters asks for a code from the authenticator, as on the web.
 */
export default function AccountSettings() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Account" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        contentContainerClassName="gap-4 p-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <T className={UI_HEADING}>Security</T>
        <TwoFactor />
        <RecoveryCodes />
        <ChangePassword />
        <Sessions />
        <DeleteAccount />
      </ScrollView>
    </View>
  );
}

function CodeList({ codes }: { codes: string[] }) {
  return (
    <View className="gap-2">
      <View className="gap-1 rounded-md border border-border bg-muted/30 p-3">
        {codes.map((code) => (
          <T key={code} selectable className="text-center font-mono text-sm tracking-[0.3em]">
            {code}
          </T>
        ))}
      </View>
      <Button
        variant="outline"
        size="sm"
        icon={Copy}
        onPress={() => {
          void Clipboard.setStringAsync(codes.join("\n"));
          showToast({ message: "Recovery codes copied" });
        }}
      >
        Copy All Codes
      </Button>
    </View>
  );
}

function TwoFactor() {
  const state = useChatter();
  const { enrollTotp } = useChatterActions();
  const [setup, setSetup] = useState<{ totp_secret: string; totp_uri: string; totp_qr_base64: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (codes) {
    return (
      <SettingsSection title="Two-Factor Authentication" hint="2FA is now enabled! Save these recovery codes in a safe place. Each code can only be used once.">
        <CodeList codes={codes} />
        <Button size="sm" onPress={() => setCodes(null)}>
          Done
        </Button>
      </SettingsSection>
    );
  }

  if (state.totpVerified) {
    return (
      <SettingsSection title="Two-Factor Authentication">
        <View className="flex-row items-center gap-2">
          <Icon as={ShieldCheck} size={16} tone="success" />
          <T className="text-sm text-success">2FA is enabled</T>
        </View>
      </SettingsSection>
    );
  }

  if (!setup) {
    return (
      <SettingsSection title="Two-Factor Authentication" hint="Your account does not have two-factor authentication enabled. Set it up to add an extra layer of security.">
        {error ? <T className="text-xs text-destructive">{error}</T> : null}
        <Button
          variant="outline"
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            setError(null);
            try {
              setSetup(await apiSetupTotp());
            } catch (e) {
              setError(errorText(e, "Failed to set up 2FA"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Setting up..." : "Set Up 2FA"}
        </Button>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Two-Factor Authentication" hint="Add Chatter to your authenticator app, then enter the 6-digit code it shows.">
      {/* The authenticator is usually on this same phone, where a QR code
          cannot be scanned: the link opens it directly. */}
      <Button variant="outline" icon={ExternalLink} onPress={() => void Linking.openURL(setup.totp_uri).catch(() => showToast({ tone: "error", message: "No authenticator app opened that link" }))}>
        Open in authenticator
      </Button>
      <View className="items-center">
        <Image source={{ uri: `data:image/png;base64,${setup.totp_qr_base64}` }} style={{ width: 160, height: 160, borderRadius: 6, backgroundColor: "#fff" }} />
      </View>
      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(setup.totp_secret);
          showToast({ message: "Key copied" });
        }}
        accessibilityRole="button"
        accessibilityHint="Copies the key"
        className="rounded bg-muted/30 px-2 py-1.5"
      >
        <T className="text-center text-3xs text-muted-foreground">Or enter this key manually (tap to copy):</T>
        <T selectable className="text-center font-mono text-xs">
          {setup.totp_secret}
        </T>
      </Pressable>
      <TextField value={code} onChangeText={(v) => setCode(digits(v))} placeholder="6-digit code" keyboardType="number-pad" maxLength={6} className="text-center tracking-widest" />
      {error ? <T className="text-xs text-destructive">{error}</T> : null}
      <View className="flex-row gap-2">
        <Button variant="outline" className="flex-1" onPress={() => (setSetup(null), setError(null), setCode(""))}>
          Cancel
        </Button>
        <Button
          className="flex-1"
          disabled={busy}
          onPress={async () => {
            if (code.length !== 6) return setError("Enter a 6-digit code");
            setBusy(true);
            setError(null);
            try {
              const { recoveryCodes } = await enrollTotp(code);
              setSetup(null);
              if (recoveryCodes.length > 0) setCodes(recoveryCodes);
            } catch (e) {
              setError(errorText(e, "Verification failed"));
            } finally {
              setBusy(false);
              setCode("");
            }
          }}
        >
          {busy ? "Verifying..." : "Verify"}
        </Button>
      </View>
    </SettingsSection>
  );
}

function RecoveryCodes() {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title="Recovery Codes" hint="These let you sign in if you lose access to your authenticator app. Each code can only be used once.">
      {codes ? (
        <>
          <CodeList codes={codes} />
          <Button variant="outline" size="sm" className="border-orange-400/30" textClassName="text-orange-400" onPress={() => (setCodes(null), setAsking(true))}>
            Regenerate Codes
          </Button>
        </>
      ) : asking ? (
        <>
          <TextField value={code} onChangeText={(v) => setCode(digits(v))} placeholder="Authenticator code" keyboardType="number-pad" maxLength={6} className="tracking-widest" />
          {error ? <T className="text-xs text-destructive">{error}</T> : null}
          <View className="flex-row gap-2">
            <Button variant="outline" size="sm" className="flex-1" onPress={() => (setAsking(false), setCode(""), setError(null))}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy}
              onPress={async () => {
                if (code.length !== 6) return setError("Enter a 6-digit authenticator code");
                setBusy(true);
                setError(null);
                try {
                  setCodes((await apiGetRecoveryCodes(code)).recovery_codes);
                  setCode("");
                  setAsking(false);
                } catch (e) {
                  setError(errorText(e, "Failed to get recovery codes"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Loading..." : "Confirm"}
            </Button>
          </View>
        </>
      ) : (
        <Button variant="outline" onPress={() => setAsking(true)}>
          View Recovery Codes
        </Button>
      )}
    </SettingsSection>
  );
}

function ChangePassword() {
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const change = async () => {
    setMessage(null);
    if (next.length < 6) return setMessage({ ok: false, text: "Password must be at least 6 characters" });
    if (next !== confirm) return setMessage({ ok: false, text: "Passwords do not match" });
    if (code.length !== 6) return setMessage({ ok: false, text: "Enter a 6-digit authenticator code" });
    setBusy(true);
    try {
      await apiChangePassword(code, next);
      setMessage({ ok: true, text: "Password changed successfully" });
      setNext("");
      setConfirm("");
      setCode("");
    } catch (e) {
      setMessage({ ok: false, text: errorText(e, "Failed to change password") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Change Password">
      <TextField value={next} onChangeText={setNext} placeholder="New password" secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" />
      <TextField value={confirm} onChangeText={setConfirm} placeholder="Confirm new password" secureTextEntry autoCapitalize="none" autoComplete="new-password" />
      <TextField value={code} onChangeText={(v) => setCode(digits(v))} placeholder="Authenticator code" keyboardType="number-pad" maxLength={6} className="tracking-widest" />
      {message ? <T className={cn("text-xs", message.ok ? "text-success" : "text-destructive")}>{message.text}</T> : null}
      <Button variant="outline" disabled={busy} onPress={() => void change()}>
        {busy ? "Changing..." : "Change Password"}
      </Button>
    </SettingsSection>
  );
}

/** A user agent as something a person reads: the browser or app, and the OS. */
function describeAgent(ua: string): { label: string; phone: boolean } {
  if (!ua || /^unknown$/i.test(ua)) return { label: "Unknown device", phone: false };
  const phone = /Android|iPhone|iPad|Mobile|okhttp|Chatter/i.test(ua);
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const app = /Electron|Chatter-Desktop/i.test(ua)
    ? "Chatter desktop"
    : /okhttp|ReactNative|Expo|Chatter\//i.test(ua)
      ? "Chatter app"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Edg\//i.test(ua)
          ? "Edge"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : ua.split(" ")[0];
  return { label: os ? `${app} on ${os}` : app, phone };
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  useEffect(() => {
    apiGetSessions()
      .then((d) => setSessions(d.sessions))
      .catch(() => setSessions([]));
  }, []);
  return (
    <SettingsSection title="Active Sessions" hint="Everywhere your account is currently signed in.">
      {sessions === null ? (
        <T className="text-xs text-muted-foreground">Loading sessions...</T>
      ) : sessions.length === 0 ? (
        <T className="text-xs text-muted-foreground">No active sessions found.</T>
      ) : (
        sessions.map((s, i) => {
          const { label, phone } = describeAgent(s.user_agent);
          return (
            <View key={s.session_id || i} className="flex-row items-start gap-3 rounded-md border border-border px-3 py-2">
              <Icon as={phone ? Smartphone : ShieldCheck} size={16} />
              <View className="min-w-0 flex-1">
                <T className="text-xs font-medium" numberOfLines={1}>
                  {label}
                </T>
                <T className="text-2xs text-muted-foreground">{s.ip_address || "Unknown IP"}</T>
                <T className="text-2xs text-muted-foreground">{s.created_at ? new Date(s.created_at).toLocaleString() : "Unknown time"}</T>
              </View>
              {s.session_id ? (
                <Pressable
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Log out ${label}`}
                  onPress={() =>
                    Alert.alert("Log out this session?", label, [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Log out",
                        style: "destructive",
                        onPress: () =>
                          void apiRevokeSession(s.session_id)
                            .then(() => setSessions((prev) => prev?.filter((x) => x.session_id !== s.session_id) ?? prev))
                            .catch((e) => showToast({ tone: "error", message: errorText(e, "Could not log that session out") })),
                      },
                    ])
                  }
                >
                  <Icon as={LogOut} size={15} />
                </Pressable>
              ) : null}
            </View>
          );
        })
      )}
    </SettingsSection>
  );
}

function DeleteAccount() {
  const { deleteAccount } = useChatterActions();
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title="Delete Account" hint="Permanently deletes your account. This cannot be undone." tone="danger">
      {!confirming ? (
        <Button variant="outline" className="border-destructive/30" textClassName="text-destructive" onPress={() => setConfirming(true)}>
          Delete Account
        </Button>
      ) : (
        <>
          <TextField value={code} onChangeText={(v) => setCode(digits(v))} placeholder="Authenticator code" keyboardType="number-pad" maxLength={6} className="tracking-widest" />
          {error ? <T className="text-xs text-destructive">{error}</T> : null}
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onPress={() => (setConfirming(false), setCode(""), setError(null))}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={busy}
              onPress={async () => {
                if (code.length !== 6) return setError("Enter a 6-digit authenticator code");
                setBusy(true);
                setError(null);
                try {
                  await deleteAccount(code);
                } catch (e) {
                  setError(errorText(e, "Failed to delete account"));
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting..." : "Confirm Delete"}
            </Button>
          </View>
        </>
      )}
    </SettingsSection>
  );
}
