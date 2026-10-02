from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Demo mode: fake devices and a fake Spotify, no credentials needed.
    demo: bool = False

    # Dashboard login (single user). Create the hash with: python -m app.hashpw
    dashboard_password_hash: str = ""
    session_secret: str = Field(default="", min_length=0)
    session_hours: int = Field(default=12, ge=1, le=168)
    # Set to false only for plain-http use inside your home network.
    cookie_secure: bool = True

    # Home Assistant (Alexa devices, lights, plugs ...)
    ha_url: str = "http://homeassistant.local:8123"
    ha_token: str = ""

    # Spotify (Premium needed for playback control)
    spotify_client_id: str = ""
    spotify_client_secret: str = ""
    spotify_redirect_uri: str = "http://127.0.0.1:8765/spotify/callback"
    data_dir: str = "data"

    # Other chatbots shown in the "Chatbots" panel: "Name|https://health-url" separated by commas
    chatbots: str = "Dayline-Assistent|https://dayline.duckdns.org/health"


@lru_cache
def get_settings() -> Settings:
    return Settings()
