import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AVATAR_BRIGHTNESS, AVATAR_LIGHTS, type AvatarLightFrom, type AvatarLook } from "@/lib/cameraBackgrounds";

const LIGHT_LABELS: Record<AvatarLightFrom, string> = {
  front: "Front",
  left: "Left",
  right: "Right",
  above: "Above",
};

const ITEM = "flex-1 text-xs h-7 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm";

interface AvatarLookControlsProps {
  look: AvatarLook;
  onChange: (look: AvatarLook) => void;
  /** The width of the row labels, to line up with the dialog's other rows. */
  labelClassName?: string;
}

/** The avatar's light and outline, as the camera picker and streamer mode
 *  both show them. */
export function AvatarLookControls({ look, onChange, labelClassName = "" }: AvatarLookControlsProps) {
  return (
    <>
      <div className="flex items-center gap-3">
        <label className={`text-xs font-medium text-muted-foreground ${labelClassName}`}>Light</label>
        <ToggleGroup
          type="single"
          value={look.lightFrom}
          onValueChange={(v) => v && onChange({ ...look, lightFrom: v as AvatarLightFrom })}
          className="flex-1 rounded-md border border-border bg-muted p-0.5"
          aria-label="Where the light comes from"
        >
          {AVATAR_LIGHTS.map((from) => (
            <ToggleGroupItem key={from} value={from} className={ITEM}>
              {LIGHT_LABELS[from]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex items-center gap-3">
        <label className={`text-xs font-medium text-muted-foreground ${labelClassName}`}>Brightness</label>
        <Slider
          min={AVATAR_BRIGHTNESS.min}
          max={AVATAR_BRIGHTNESS.max}
          step={0.05}
          value={[look.brightness]}
          onValueChange={([brightness]) => onChange({ ...look, brightness })}
          className="flex-1"
          aria-label="Avatar brightness"
        />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {Math.round(look.brightness * 100)}%
        </span>
      </div>
      <div className="flex items-center gap-3">
        <label className={`text-xs font-medium text-muted-foreground ${labelClassName}`}>Outline</label>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[look.outline]}
          onValueChange={([outline]) => onChange({ ...look, outline })}
          className="flex-1"
          aria-label="Avatar outline"
        />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {look.outline === 0 ? "Off" : `${Math.round(look.outline * 100)}%`}
        </span>
      </div>
    </>
  );
}
