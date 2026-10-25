//! The pure parts of forwarding a simulcast camera: which encoding a viewer
//! gets, when it is safe to change to another, and how the packets of two
//! encodings are stitched into the one stream the viewer's decoder sees.
//!
//! A simulcast camera sends each encoding as its own RTP stream, told apart by
//! its `rid`: "h" full size, "l" a quarter. A camera sent without simulcast (an
//! older client, the Android app) has one stream with an empty rid, and is
//! every quality at once.

use std::time::Instant;

/// What a viewer asks of a camera: the full picture, or one small enough for
/// a thumbnail or a grid tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WebcamQuality {
    High,
    Low,
}

impl WebcamQuality {
    /// A client's word for it. Anything unrecognised is the full picture —
    /// which is all there was before viewers could ask.
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("low") => Self::Low,
            _ => Self::High,
        }
    }
}

/// An encoding's place from smallest to largest. No rid — a camera sent
/// without simulcast — is its only encoding, so it ranks as the largest.
fn rank(rid: &str) -> u8 {
    match rid {
        "l" | "q" => 0,
        "m" => 1,
        _ => 2,
    }
}

/// Of the encodings `rids` a camera is sending, the one for `quality`: the
/// largest for High, the smallest for Low. `None` only when there are none.
pub(crate) fn pick_layer<'a, I>(rids: I, quality: WebcamQuality) -> Option<&'a str>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut iter = rids.into_iter();
    let first = iter.next()?;
    Some(iter.fold(first, |best, rid| {
        let better = match quality {
            WebcamQuality::High => rank(rid) > rank(best),
            WebcamQuality::Low => rank(rid) < rank(best),
        };
        if better {
            rid
        } else {
            best
        }
    }))
}

/// Whether `payload` begins a keyframe, for a camera sent as `mime_type`.
/// `None` for a codec this does not know how to read, which the caller treats
/// as "switch now and ask for a keyframe".
///
/// A viewer can only be moved to another encoding on a keyframe of it: every
/// other frame is drawn from the one before, and the one before was from the
/// encoding they are leaving.
pub(crate) fn starts_keyframe(mime_type: &str, payload: &[u8]) -> Option<bool> {
    if payload.is_empty() {
        // Padding: a probe for bandwidth, not a frame.
        return Some(false);
    }
    match mime_type.to_ascii_lowercase().as_str() {
        "video/vp8" => Some(vp8_starts_keyframe(payload)),
        "video/vp9" => Some(vp9_starts_keyframe(payload)),
        "video/h264" => Some(h264_starts_keyframe(payload)),
        _ => None,
    }
}

/// RFC 7741: the payload descriptor, then — on the first packet of a frame —
/// the VP8 header, whose lowest bit is 0 on a keyframe.
fn vp8_starts_keyframe(payload: &[u8]) -> bool {
    let first = payload[0];
    let extended = first & 0x80 != 0;
    let start_of_partition = first & 0x10 != 0;
    let partition_index = first & 0x07;
    if !start_of_partition || partition_index != 0 {
        return false;
    }
    let mut offset = 1;
    if extended {
        let Some(&ext) = payload.get(offset) else {
            return false;
        };
        offset += 1;
        if ext & 0x80 != 0 {
            // PictureID: one byte, or two with the M bit.
            let Some(&pid) = payload.get(offset) else {
                return false;
            };
            offset += if pid & 0x80 != 0 { 2 } else { 1 };
        }
        if ext & 0x40 != 0 {
            offset += 1; // TL0PICIDX
        }
        if ext & 0x30 != 0 {
            offset += 1; // TID / KEYIDX
        }
    }
    payload.get(offset).is_some_and(|header| header & 0x01 == 0)
}

/// The VP9 payload descriptor's first byte: B marks the start of a frame and P
/// one predicted from an earlier frame, so a keyframe starts with B and no P.
fn vp9_starts_keyframe(payload: &[u8]) -> bool {
    let first = payload[0];
    let inter_predicted = first & 0x40 != 0;
    let begins_frame = first & 0x08 != 0;
    begins_frame && !inter_predicted
}

/// RFC 6184: an IDR slice (5) or a sequence parameter set (7), alone, in a
/// STAP-A aggregate (24), or as the first fragment of an FU-A (28). Browsers
/// send the SPS just ahead of the IDR, so either marks the start.
fn h264_starts_keyframe(payload: &[u8]) -> bool {
    const IDR: u8 = 5;
    const SPS: u8 = 7;
    const STAP_A: u8 = 24;
    const FU_A: u8 = 28;
    let is_key = |nal_type: u8| nal_type == IDR || nal_type == SPS;
    match payload[0] & 0x1f {
        STAP_A => {
            let mut offset = 1;
            while offset + 2 < payload.len() {
                let size = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
                let Some(&nal) = payload.get(offset + 2) else {
                    return false;
                };
                if is_key(nal & 0x1f) {
                    return true;
                }
                offset += 2 + size;
            }
            false
        }
        FU_A => payload
            .get(1)
            .is_some_and(|fu| fu & 0x80 != 0 && is_key(fu & 0x1f)),
        nal_type => is_key(nal_type),
    }
}

/// Stitches one viewer's packets into a single stream across encodings.
///
/// Each encoding numbers its packets and stamps its frames from its own random
/// start, so a viewer moved from one to another would see the sequence jump
/// and time leap, and take it for loss or a stall. Each source is offset so
/// that its first packet follows on from the last one sent: the next sequence
/// number, and a timestamp as far on as the wall clock has moved.
///
/// Within one source the offset is fixed, so its own gaps and reordering reach
/// the viewer as they were — which is what lets them ask for a lost packet
/// again.
pub(crate) struct VideoRestamp {
    clock_rate: u32,
    seq_offset: u16,
    ts_offset: u32,
    rebase: bool,
    /// The newest packet sent: sequence number, timestamp, and when.
    last: Option<(u16, u32, Instant)>,
}

impl VideoRestamp {
    pub(crate) fn new(clock_rate: u32) -> Self {
        Self {
            clock_rate: clock_rate.max(1),
            seq_offset: 0,
            ts_offset: 0,
            rebase: true,
            last: None,
        }
    }

    /// The next packet is from a different encoding.
    pub(crate) fn switch_source(&mut self) {
        self.rebase = true;
    }

    /// The sequence number and timestamp to send `sequence_number` and
    /// `timestamp` of the current source as.
    pub(crate) fn stamp(
        &mut self,
        sequence_number: u16,
        timestamp: u32,
        now: Instant,
    ) -> (u16, u32) {
        if self.rebase {
            self.rebase = false;
            match self.last {
                Some((last_seq, last_ts, last_at)) => {
                    let elapsed = now.saturating_duration_since(last_at).as_secs_f64();
                    let ticks = ((elapsed * f64::from(self.clock_rate)) as u32).max(1);
                    self.seq_offset = last_seq.wrapping_add(1).wrapping_sub(sequence_number);
                    self.ts_offset = last_ts.wrapping_add(ticks).wrapping_sub(timestamp);
                }
                // The first source goes out as it came.
                None => {
                    self.seq_offset = 0;
                    self.ts_offset = 0;
                }
            }
        }
        let out_seq = sequence_number.wrapping_add(self.seq_offset);
        let out_ts = timestamp.wrapping_add(self.ts_offset);
        // A late packet is sent where it belongs, but is not the newest.
        let newer = match self.last {
            None => true,
            Some((last_seq, _, _)) => {
                let ahead = out_seq.wrapping_sub(last_seq);
                ahead != 0 && ahead < 0x8000
            }
        };
        if newer {
            self.last = Some((out_seq, out_ts, now));
        }
        (out_seq, out_ts)
    }
}

/// Where VP8's own frame numbering sits in a packet's payload descriptor.
struct Vp8Ids {
    /// Offset of the PictureID, and whether it is the 15-bit form.
    picture_id: Option<(usize, bool)>,
    tl0_pic_idx: Option<usize>,
}

fn vp8_ids(payload: &[u8]) -> Vp8Ids {
    let none = Vp8Ids {
        picture_id: None,
        tl0_pic_idx: None,
    };
    if payload.first().is_none_or(|b| b & 0x80 == 0) {
        return none;
    }
    let Some(&ext) = payload.get(1) else {
        return none;
    };
    let mut offset = 2;
    let mut picture_id = None;
    if ext & 0x80 != 0 {
        let Some(&first) = payload.get(offset) else {
            return none;
        };
        let long = first & 0x80 != 0;
        let len = if long { 2 } else { 1 };
        if payload.len() < offset + len {
            return none;
        }
        picture_id = Some((offset, long));
        offset += len;
    }
    let tl0_pic_idx = (ext & 0x40 != 0 && payload.len() > offset).then_some(offset);
    Vp8Ids {
        picture_id,
        tl0_pic_idx,
    }
}

/// Keeps VP8's own frame numbering continuous across encodings, as
/// `VideoRestamp` does the RTP header's.
///
/// VP8 numbers its frames inside the payload — a PictureID per frame and a
/// TL0PICIDX per base-layer frame — and each encoding counts from its own
/// start. A viewer moved between them would see the numbers jump, possibly
/// backwards, and a receiver tracking which frames each one refers to can
/// take the new frames for stale ones and drop them.
pub(crate) struct Vp8Munger {
    picture_id_offset: u16,
    tl0_offset: u8,
    rebase: bool,
    /// The newest PictureID (as 15 bits) and TL0PICIDX sent.
    last_picture_id: Option<u16>,
    last_tl0: Option<u8>,
}

impl Vp8Munger {
    pub(crate) fn new() -> Self {
        Self {
            picture_id_offset: 0,
            tl0_offset: 0,
            rebase: true,
            last_picture_id: None,
            last_tl0: None,
        }
    }

    /// The next packet is from a different encoding.
    pub(crate) fn switch_source(&mut self) {
        self.rebase = true;
    }

    /// `payload` renumbered to follow on from what was sent before, or `None`
    /// when it goes out unchanged — always, until the first switch.
    pub(crate) fn rewrite(&mut self, payload: &[u8]) -> Option<Vec<u8>> {
        let ids = vp8_ids(payload);
        let read_picture_id = |(at, long): (usize, bool)| {
            if long {
                u16::from_be_bytes([payload[at] & 0x7f, payload[at + 1]])
            } else {
                u16::from(payload[at] & 0x7f)
            }
        };
        let picture_id = ids.picture_id.map(read_picture_id);
        let tl0 = ids.tl0_pic_idx.map(|at| payload[at]);

        if self.rebase && picture_id.is_some() {
            self.rebase = false;
            if let (Some(last), Some(id)) = (self.last_picture_id, picture_id) {
                self.picture_id_offset = last.wrapping_add(1).wrapping_sub(id) & 0x7fff;
            }
            if let (Some(last), Some(idx)) = (self.last_tl0, tl0) {
                self.tl0_offset = last.wrapping_add(1).wrapping_sub(idx);
            }
        }

        let out_picture_id = picture_id.map(|id| id.wrapping_add(self.picture_id_offset) & 0x7fff);
        let out_tl0 = tl0.map(|idx| idx.wrapping_add(self.tl0_offset));
        if let Some(id) = out_picture_id {
            let ahead = self
                .last_picture_id
                .map(|last| id.wrapping_sub(last) & 0x7fff);
            if ahead.is_none_or(|a| a < 0x4000) {
                self.last_picture_id = Some(id);
                if out_tl0.is_some() {
                    self.last_tl0 = out_tl0;
                }
            }
        }

        if self.picture_id_offset == 0 && self.tl0_offset == 0 {
            return None;
        }
        let mut out = payload.to_vec();
        if let (Some((at, long)), Some(id)) = (ids.picture_id, out_picture_id) {
            if long {
                out[at] = 0x80 | ((id >> 8) as u8 & 0x7f);
                out[at + 1] = id as u8;
            } else {
                out[at] = id as u8 & 0x7f;
            }
        }
        if let (Some(at), Some(idx)) = (ids.tl0_pic_idx, out_tl0) {
            out[at] = idx;
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn quality_defaults_to_high() {
        assert_eq!(WebcamQuality::parse(Some("low")), WebcamQuality::Low);
        assert_eq!(WebcamQuality::parse(Some("high")), WebcamQuality::High);
        assert_eq!(WebcamQuality::parse(Some("medium")), WebcamQuality::High);
        assert_eq!(WebcamQuality::parse(None), WebcamQuality::High);
    }

    #[test]
    fn picks_the_largest_and_smallest_layer() {
        assert_eq!(pick_layer(["l", "h"], WebcamQuality::High), Some("h"));
        assert_eq!(pick_layer(["h", "l"], WebcamQuality::Low), Some("l"));
        assert_eq!(pick_layer(["l", "m", "h"], WebcamQuality::Low), Some("l"));
        assert_eq!(pick_layer(["l", "m", "h"], WebcamQuality::High), Some("h"));
    }

    #[test]
    fn a_camera_without_simulcast_is_every_quality() {
        assert_eq!(pick_layer([""], WebcamQuality::High), Some(""));
        assert_eq!(pick_layer([""], WebcamQuality::Low), Some(""));
    }

    #[test]
    fn a_missing_layer_falls_back_to_what_there_is() {
        // The high layer has not arrived yet, or the sender dropped it.
        assert_eq!(pick_layer(["l"], WebcamQuality::High), Some("l"));
        assert_eq!(pick_layer(["h"], WebcamQuality::Low), Some("h"));
        assert_eq!(
            pick_layer(std::iter::empty::<&str>(), WebcamQuality::High),
            None
        );
    }

    #[test]
    fn vp8_keyframes() {
        // S=1, PID=0, no extension; VP8 header P bit clear.
        assert_eq!(starts_keyframe("video/VP8", &[0x10, 0x00]), Some(true));
        // Same, but an inter frame.
        assert_eq!(starts_keyframe("video/VP8", &[0x10, 0x01]), Some(false));
        // Not the start of a partition.
        assert_eq!(starts_keyframe("video/VP8", &[0x00, 0x00]), Some(false));
        // Extended with a two-byte PictureID, TL0PICIDX and TID/KEYIDX.
        assert_eq!(
            starts_keyframe("video/VP8", &[0x90, 0xf0, 0x80, 0x01, 0x05, 0x20, 0x00]),
            Some(true)
        );
        assert_eq!(
            starts_keyframe("video/VP8", &[0x90, 0xf0, 0x80, 0x01, 0x05, 0x20, 0x01]),
            Some(false)
        );
        // Truncated: not a keyframe rather than a panic.
        assert_eq!(starts_keyframe("video/VP8", &[0x90, 0x80]), Some(false));
    }

    #[test]
    fn vp9_keyframes() {
        // B set, P clear.
        assert_eq!(starts_keyframe("video/VP9", &[0x08]), Some(true));
        // B and P: a predicted frame.
        assert_eq!(starts_keyframe("video/VP9", &[0x48]), Some(false));
        // Not the beginning of a frame.
        assert_eq!(starts_keyframe("video/VP9", &[0x00]), Some(false));
    }

    #[test]
    fn h264_keyframes() {
        // A lone IDR and a lone SPS.
        assert_eq!(starts_keyframe("video/H264", &[0x65]), Some(true));
        assert_eq!(starts_keyframe("video/H264", &[0x67]), Some(true));
        // A lone non-IDR slice.
        assert_eq!(starts_keyframe("video/H264", &[0x41]), Some(false));
        // STAP-A carrying an SPS then a PPS.
        assert_eq!(
            starts_keyframe(
                "video/H264",
                &[0x78, 0x00, 0x02, 0x67, 0x42, 0x00, 0x01, 0x68]
            ),
            Some(true)
        );
        // STAP-A carrying only a PPS.
        assert_eq!(
            starts_keyframe("video/H264", &[0x78, 0x00, 0x01, 0x68]),
            Some(false)
        );
        // FU-A: the first fragment of an IDR, then a later one.
        assert_eq!(
            starts_keyframe("video/H264", &[0x7c, 0x85, 0x00]),
            Some(true)
        );
        assert_eq!(
            starts_keyframe("video/H264", &[0x7c, 0x05, 0x00]),
            Some(false)
        );
    }

    #[test]
    fn padding_is_never_a_keyframe_and_unknown_codecs_are_unknown() {
        assert_eq!(starts_keyframe("video/VP8", &[]), Some(false));
        assert_eq!(starts_keyframe("video/AV1", &[0x10]), None);
    }

    #[test]
    fn the_first_source_passes_through() {
        let now = Instant::now();
        let mut r = VideoRestamp::new(90_000);
        assert_eq!(r.stamp(1000, 50_000, now), (1000, 50_000));
        assert_eq!(r.stamp(1001, 53_000, now), (1001, 53_000));
    }

    #[test]
    fn a_switch_follows_on_from_the_last_packet() {
        let start = Instant::now();
        let mut r = VideoRestamp::new(90_000);
        r.stamp(1000, 50_000, start);
        r.stamp(1001, 53_000, start);
        r.switch_source();
        // A different encoding, numbered from somewhere else entirely, a
        // tenth of a second later.
        let later = start + Duration::from_millis(100);
        assert_eq!(r.stamp(40_000, 9_000_000, later), (1002, 53_000 + 9_000));
        assert_eq!(r.stamp(40_001, 9_003_000, later), (1003, 56_000 + 9_000));
    }

    #[test]
    fn gaps_and_reordering_within_a_source_survive() {
        let now = Instant::now();
        let mut r = VideoRestamp::new(90_000);
        r.stamp(10, 0, now);
        r.switch_source();
        r.stamp(500, 0, now);
        // 501 is lost, 503 arrives before 502.
        assert_eq!(r.stamp(503, 0, now).0, 14);
        assert_eq!(r.stamp(502, 0, now).0, 13);
        // The late one did not become the newest: a switch follows 503.
        r.switch_source();
        assert_eq!(r.stamp(7, 0, now).0, 15);
    }

    #[test]
    fn sequence_numbers_wrap() {
        let now = Instant::now();
        let mut r = VideoRestamp::new(90_000);
        r.stamp(u16::MAX, u32::MAX, now);
        r.switch_source();
        let (seq, _) = r.stamp(5, 0, now);
        assert_eq!(seq, 0);
        assert_eq!(r.stamp(6, 0, now).0, 1);
    }

    /// A VP8 packet with a 15-bit PictureID and a TL0PICIDX, then one byte of
    /// VP8 header.
    fn vp8(picture_id: u16, tl0: u8) -> Vec<u8> {
        vec![
            0x90,
            0xc0,
            0x80 | (picture_id >> 8) as u8,
            picture_id as u8,
            tl0,
            0x00,
        ]
    }

    fn ids(payload: &[u8]) -> (u16, u8) {
        (
            u16::from_be_bytes([payload[2] & 0x7f, payload[3]]),
            payload[4],
        )
    }

    #[test]
    fn vp8_numbering_passes_through_until_a_switch() {
        let mut m = Vp8Munger::new();
        assert_eq!(m.rewrite(&vp8(100, 7)), None);
        assert_eq!(m.rewrite(&vp8(101, 8)), None);
    }

    #[test]
    fn vp8_numbering_follows_on_across_a_switch() {
        let mut m = Vp8Munger::new();
        m.rewrite(&vp8(100, 7));
        m.rewrite(&vp8(101, 8));
        m.switch_source();
        // The other encoding counts from somewhere else, even behind.
        let out = m.rewrite(&vp8(20, 200)).expect("renumbered");
        assert_eq!(ids(&out), (102, 9));
        let out = m.rewrite(&vp8(21, 201)).expect("renumbered");
        assert_eq!(ids(&out), (103, 10));
        // Only the numbers change.
        assert_eq!(out[0..2], [0x90, 0xc0]);
        assert_eq!(out[5], 0x00);
    }

    #[test]
    fn vp8_picture_ids_wrap_at_fifteen_bits() {
        let mut m = Vp8Munger::new();
        m.rewrite(&vp8(0x7fff, 0));
        m.switch_source();
        let out = m.rewrite(&vp8(500, 0)).expect("renumbered");
        assert_eq!(ids(&out).0, 0);
    }

    #[test]
    fn vp8_short_picture_ids_and_no_ids() {
        let mut m = Vp8Munger::new();
        // 7-bit PictureID, no TL0PICIDX.
        m.rewrite(&[0x90, 0x80, 0x10, 0x00]);
        m.switch_source();
        let out = m.rewrite(&[0x90, 0x80, 0x05, 0x00]).expect("renumbered");
        assert_eq!(out[2], 0x11);
        // A descriptor without the extension has nothing to renumber.
        let mut m = Vp8Munger::new();
        m.switch_source();
        assert_eq!(m.rewrite(&[0x10, 0x00]), None);
    }
}
