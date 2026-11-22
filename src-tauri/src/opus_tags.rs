use base64::Engine as _;
use std::io::Write;
use std::path::Path;
use symphonia::core::codecs::CODEC_TYPE_OPUS;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct Tags<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub album: &'a str,
    pub cover_jpeg: Option<&'a [u8]>,
}

// do Matroski tagów nie zapisze żaden crate, a Ogg Opus trzyma tytuł i okładkę w pakiecie OpusTags (RFC 7845)
pub fn webm_to_ogg(src: &Path, dst: &Path, tags: &Tags) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension("webm");
    let mut fmt = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {e}"))?
        .format;
    let track = fmt
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_OPUS)
        .ok_or("not opus")?;
    let id = track.id;
    let head = track
        .codec_params
        .extra_data
        .clone()
        .filter(|h| h.len() >= 19 && h.starts_with(b"OpusHead"))
        .ok_or("no OpusHead")?;
    let packets = std::iter::from_fn(|| loop {
        match fmt.next_packet() {
            Ok(p) if p.track_id() == id => return Some(Ok(p.data.into_vec())),
            Ok(_) => continue,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return None
            }
            Err(e) => return Some(Err(e.to_string())),
        }
    });
    let out = std::fs::File::create(dst).map_err(|e| e.to_string())?;
    write_ogg(&head, tags, packets, std::io::BufWriter::new(out))
}

fn write_ogg<W: Write>(
    head: &[u8],
    tags: &Tags,
    packets: impl Iterator<Item = Result<Vec<u8>, String>>,
    w: W,
) -> Result<(), String> {
    let mut ogg = Ogg::new(w);
    let io = |e: std::io::Error| e.to_string();
    ogg.push(head, 0).map_err(io)?;
    ogg.flush(BOS).map_err(io)?;
    // komentarze muszą skończyć własną stronę, pierwszy pakiet dźwięku zaczyna nową
    ogg.push(&opus_tags(tags), 0).map_err(io)?;
    ogg.flush(0).map_err(io)?;
    let mut granule = 0u64;
    let mut any = false;
    for p in packets {
        let p = p?;
        let len = i32::try_from(p.len()).map_err(|_| "packet too large")?;
        let n = unsafe { opusic_sys::opus_packet_get_nb_samples(p.as_ptr(), len, 48000) };
        if n < 0 {
            return Err(format!("bad opus packet {n}"));
        }
        granule += n as u64;
        ogg.push(&p, granule).map_err(io)?;
        any = true;
    }
    if !any {
        return Err("no audio".into());
    }
    ogg.flush(EOS).map_err(io)?;
    ogg.w.flush().map_err(io)
}

fn opus_tags(t: &Tags) -> Vec<u8> {
    let mut c: Vec<String> = [("TITLE", t.title), ("ARTIST", t.artist), ("ALBUM", t.album)]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    if let Some(img) = t.cover_jpeg {
        let b64 = base64::engine::general_purpose::STANDARD.encode(picture(img));
        c.push(format!("METADATA_BLOCK_PICTURE={b64}"));
    }
    let vendor = b"Zenith";
    let mut p = b"OpusTags".to_vec();
    p.extend((vendor.len() as u32).to_le_bytes());
    p.extend(vendor);
    p.extend((c.len() as u32).to_le_bytes());
    for s in &c {
        p.extend((s.len() as u32).to_le_bytes());
        p.extend(s.as_bytes());
    }
    p
}

// blok PICTURE z FLAC: typ 3 to przednia okładka
fn picture(jpeg: &[u8]) -> Vec<u8> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(jpeg))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0));
    let mime = b"image/jpeg";
    let mut b = Vec::with_capacity(jpeg.len() + 42);
    b.extend(3u32.to_be_bytes());
    b.extend((mime.len() as u32).to_be_bytes());
    b.extend(mime);
    for n in [0, w, h, 24, 0, jpeg.len() as u32] {
        b.extend(n.to_be_bytes());
    }
    b.extend(jpeg);
    b
}

const BOS: u8 = 2;
const EOS: u8 = 4;
const CONTINUED: u8 = 1;
const PAGE_BYTES: usize = 4096;
const SERIAL: u32 = 0x5A45_4E49;

struct Ogg<W: Write> {
    w: W,
    seq: u32,
    segs: Vec<u8>,
    body: Vec<u8>,
    // granula ostatniego pakietu zakończonego na tej stronie; strona bez takiego pakietu ma -1
    granule: Option<u64>,
    continued: bool,
}

impl<W: Write> Ogg<W> {
    fn new(w: W) -> Self {
        Self {
            w,
            seq: 0,
            segs: Vec::new(),
            body: Vec::new(),
            granule: None,
            continued: false,
        }
    }

    fn push(&mut self, data: &[u8], granule: u64) -> std::io::Result<()> {
        if self.body.len() >= PAGE_BYTES {
            self.flush(0)?;
        }
        let mut rest = data;
        loop {
            if self.segs.len() == 255 {
                // segment 255 na końcu strony znaczy, że pakiet ciągnie się na następną
                let open = self.segs.last() == Some(&255);
                self.flush(0)?;
                self.continued = open;
            }
            let n = rest.len().min(255);
            self.segs.push(n as u8);
            self.body.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
            if n < 255 {
                break;
            }
        }
        self.granule = Some(granule);
        Ok(())
    }

    fn flush(&mut self, flags: u8) -> std::io::Result<()> {
        let mut page = Vec::with_capacity(27 + self.segs.len() + self.body.len());
        page.extend(b"OggS\0");
        page.push(flags | if self.continued { CONTINUED } else { 0 });
        page.extend(self.granule.unwrap_or(u64::MAX).to_le_bytes());
        page.extend(SERIAL.to_le_bytes());
        page.extend(self.seq.to_le_bytes());
        page.extend([0; 4]);
        page.push(self.segs.len() as u8);
        page.extend(&self.segs);
        page.extend(&self.body);
        let crc = crc32(&page);
        page[22..26].copy_from_slice(&crc.to_le_bytes());
        self.w.write_all(&page)?;
        self.seq += 1;
        self.segs.clear();
        self.body.clear();
        self.granule = None;
        self.continued = false;
        Ok(())
    }
}

// CRC Ogg: wielomian 0x04C11DB7 bez odbicia bitów i bez końcowego XOR
fn crc32(data: &[u8]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut t = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut r = (i as u32) << 24;
            let mut k = 0;
            while k < 8 {
                r = if r & 0x8000_0000 != 0 {
                    (r << 1) ^ 0x04C1_1DB7
                } else {
                    r << 1
                };
                k += 1;
            }
            t[i] = r;
            i += 1;
        }
        t
    };
    data.iter().fold(0u32, |crc, &b| {
        (crc << 8) ^ TABLE[((crc >> 24) as u8 ^ b) as usize]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphonia::core::meta::StandardTagKey;

    fn head() -> Vec<u8> {
        let mut h = b"OpusHead".to_vec();
        h.extend([1, 2]);
        h.extend(312u16.to_le_bytes());
        h.extend(48000u32.to_le_bytes());
        h.extend([0, 0, 0]);
        h
    }

    #[test]
    fn ogg_output_reads_back_with_tags_cover_and_every_packet() {
        let mut jpeg = Vec::new();
        image::RgbImage::from_pixel(300, 300, image::Rgb([200, 40, 90]))
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        // okładka większa niż 64 KB, żeby OpusTags przeszedł przez kilka stron
        jpeg.resize(90_000, 0);
        let tags = Tags {
            title: "Feel Good Inc",
            artist: "Gorillaz",
            album: "Demon Days",
            cover_jpeg: Some(&jpeg),
        };
        // TOC 0xF8: CELT pełnopasmowy, 20 ms, jedna ramka = 960 próbek
        let packets = (0..500).map(|i| Ok(vec![0xF8, i as u8, 7, 7, 7]));
        let mut out = Vec::new();
        write_ogg(&head(), &tags, packets, &mut out).unwrap();

        let mss = MediaSourceStream::new(
            Box::new(std::io::Cursor::new(out)),
            MediaSourceStreamOptions::default(),
        );
        let mut probed = symphonia::default::get_probe()
            .format(
                Hint::new().with_extension("ogg"),
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .unwrap();
        let mut fmt = probed.format;
        let t = &fmt.tracks()[0];
        assert_eq!(t.codec_params.codec, CODEC_TYPE_OPUS);
        assert_eq!(t.codec_params.extra_data.as_deref(), Some(&head()[..]));
        let mut n = 0;
        while let Ok(p) = fmt.next_packet() {
            assert_eq!(&p.data[..], &[0xF8, n as u8, 7, 7, 7]);
            n += 1;
        }
        assert_eq!(n, 500);
        let rev = fmt
            .metadata()
            .skip_to_latest()
            .cloned()
            .or_else(|| probed.metadata.get().and_then(|m| m.current().cloned()))
            .expect("OpusTags");
        let tag = |k| {
            rev.tags()
                .iter()
                .find(|t| t.std_key == Some(k))
                .map(|t| t.value.to_string())
        };
        assert_eq!(
            tag(StandardTagKey::TrackTitle).as_deref(),
            Some("Feel Good Inc")
        );
        assert_eq!(tag(StandardTagKey::Artist).as_deref(), Some("Gorillaz"));
        assert_eq!(tag(StandardTagKey::Album).as_deref(), Some("Demon Days"));
        assert_eq!(rev.visuals().len(), 1);
        assert_eq!(rev.visuals()[0].data.len(), 90_000);
        assert_eq!(
            rev.visuals()[0].dimensions.map(|d| (d.width, d.height)),
            Some((300, 300))
        );
    }

    // ZENITH_WEBM=<plik z YouTube> cargo test --lib opus_tags -- --ignored; wynik obok jako .opus
    #[test]
    #[ignore]
    fn converts_a_real_youtube_webm() {
        let src = std::path::PathBuf::from(std::env::var("ZENITH_WEBM").expect("ZENITH_WEBM"));
        let mut jpeg = Vec::new();
        image::RgbImage::from_pixel(300, 300, image::Rgb([200, 40, 90]))
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        let tags = Tags {
            title: "Feel Good Inc",
            artist: "Gorillaz",
            album: "Demon Days",
            cover_jpeg: Some(&jpeg),
        };
        webm_to_ogg(&src, &src.with_extension("opus"), &tags).unwrap();
    }

    #[test]
    fn ogg_crc_matches_the_spec_check_value() {
        // wartość kontrolna CRC-32/MPEG-2 bez końcowego XOR dla "123456789" przy init 0
        assert_eq!(crc32(b"123456789"), 0x89A1_897F);
    }
}
