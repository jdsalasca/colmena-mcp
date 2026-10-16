use colmena_widget::framebuffer::FrameBuffer;
use colmena_widget::jobs::{Job, JobState};
use colmena_widget::render::render;
use colmena_widget::scene::{Rect, Scene, position_at, reconcile, tooltip_for};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
const STARTED_AT_MS: i64 = 9_000;
const NOW_MS: i64 = 10_000;
const BACKGROUND: [u8; 3] = [236, 228, 201];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/scene-preview.ppm"));
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    let initial_jobs = sample_jobs();
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: WIDTH as f32,
        height: HEIGHT as f32,
    };
    let active_scene = reconcile(&Scene::default(), &initial_jobs, STARTED_AT_MS, bounds);
    let current_jobs = terminal_transitions(initial_jobs);
    let scene = reconcile(&active_scene, &current_jobs, STARTED_AT_MS + 400, bounds);
    let hovered = scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "running-blue"))
        .ok_or("running sample bee is missing")?;
    let anchor = position_at(hovered, NOW_MS);
    let tooltip = tooltip_for(
        hovered.job.as_ref().ok_or("running bee has no job")?,
        NOW_MS,
    );
    let scene_frame = render(&scene, NOW_MS, WIDTH, HEIGHT, None);
    let hover_frame = render(&scene, NOW_MS, WIDTH, HEIGHT, Some((&tooltip, anchor)));
    let preview = side_by_side(&scene_frame, &hover_frame);
    write_ppm(&output, &preview)?;
    println!("Wrote {} ({}x{})", output.display(), WIDTH * 2, HEIGHT);
    Ok(())
}

fn sample_jobs() -> Vec<Job> {
    vec![
        job(
            "queued-gold",
            JobState::Queued,
            "luna-max",
            "Esperar análisis de cambios",
        ),
        job(
            "running-blue",
            JobState::Running,
            "deepseek-flash",
            "Revisar tareas del widget en el workspace",
        ),
        job(
            "done-green",
            JobState::Running,
            "max-hive",
            "Preparar resumen de entrega",
        ),
        job(
            "failed-neutral",
            JobState::Running,
            "claude-code",
            "Validar importaciones del binario",
        ),
        job(
            "cancelled",
            JobState::Running,
            "cursor",
            "Actualizar documentación del proyecto",
        ),
        job(
            "orphaned-blue",
            JobState::Running,
            "ds-r1",
            "Explorar archivos de configuración",
        ),
    ]
}

fn terminal_transitions(mut jobs: Vec<Job>) -> Vec<Job> {
    for job in &mut jobs {
        let state = match job.id.as_str() {
            "done-green" => JobState::Done,
            "failed-neutral" => JobState::Failed,
            "cancelled" => JobState::Cancelled,
            "orphaned-blue" => JobState::Orphaned,
            _ => continue,
        };
        job.state = state;
        job.ended_at = Some(STARTED_AT_MS + 400);
    }
    jobs
}

fn job(id: &str, state: JobState, worker: &str, task: &str) -> Job {
    Job {
        id: id.to_owned(),
        state,
        kind: Some("run".to_owned()),
        task: Some(task.to_owned()),
        worker: Some(worker.to_owned()),
        provider: Some("synthetic".to_owned()),
        branch: Some("widget/preview".to_owned()),
        created_at: Some(STARTED_AT_MS - 12_000),
        started_at: Some(STARTED_AT_MS),
        ended_at: None,
        cost_usd: Some(0.0123),
    }
}

fn write_ppm(path: &std::path::Path, frame: &FrameBuffer) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    write!(file, "P6\n{} {}\n255\n", frame.width, frame.height)?;
    for &pixel in &frame.pixels {
        file.write_all(&flatten(pixel))?;
    }
    Ok(())
}

fn side_by_side(left: &FrameBuffer, right: &FrameBuffer) -> FrameBuffer {
    let mut combined = FrameBuffer::new(left.width + right.width, left.height.max(right.height));
    for y in 0..left.height.min(right.height) as usize {
        let row_width = left.width as usize;
        let combined_width = combined.width as usize;
        let source = y * row_width;
        let destination = y * combined_width;
        combined.pixels[destination..destination + row_width]
            .copy_from_slice(&left.pixels[source..source + row_width]);
        combined.pixels[destination + row_width..destination + row_width * 2]
            .copy_from_slice(&right.pixels[source..source + row_width]);
    }
    combined
}

fn flatten(premultiplied_bgra: u32) -> [u8; 3] {
    let alpha = (premultiplied_bgra >> 24) & 0xff;
    let inverse_alpha = 255 - alpha;
    [
        composite(
            (premultiplied_bgra >> 16) & 0xff,
            BACKGROUND[0],
            inverse_alpha,
        ),
        composite(
            (premultiplied_bgra >> 8) & 0xff,
            BACKGROUND[1],
            inverse_alpha,
        ),
        composite(premultiplied_bgra & 0xff, BACKGROUND[2], inverse_alpha),
    ]
}

fn composite(channel: u32, background: u8, inverse_alpha: u32) -> u8 {
    (channel + (u32::from(background) * inverse_alpha + 127) / 255).min(255) as u8
}
