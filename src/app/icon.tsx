import { ImageResponse } from "next/og";

/** The browser-tab icon, generated as a PNG at build time.
 *
 * This started as an icon.svg and browsers showed the default grey globe
 * instead. The reason is worth writing down: an SVG favicon is rendered
 * without a font context, so any <text> in it may simply not draw — and a
 * favicon that fails to draw falls back to the generic placeholder rather than
 * to something readable. Rasterising here sidesteps it entirely: the letters
 * are turned into pixels on our side, where fonts do exist, and every browser
 * gets a plain PNG it cannot fail to render.
 *
 * Navy #01052A is the app's own ink (--foreground) and #007BE4 its single
 * accent (--primary), so the tab matches the product rather than guessing at a
 * brand. A filled tile rather than bare letters because this is drawn at 16px
 * in a real tab strip: a solid high-contrast shape stays legible there, and it
 * works against both light and dark tab bars, which a transparent mark does
 * not. */
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#01052A",
          borderRadius: 14,
          color: "#FFFFFF",
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: -1,
          position: "relative",
        }}
      >
        FN
        {/* One dot of brand blue — enough asymmetry to tell this tab apart from
            any other dark square at a glance. */}
        <div
          style={{
            position: "absolute",
            top: 9,
            right: 9,
            width: 12,
            height: 12,
            borderRadius: 6,
            background: "#007BE4",
          }}
        />
      </div>
    ),
    size
  );
}
