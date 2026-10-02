"""Create the password hash for DASHBOARD_PASSWORD_HASH:  python -m app.hashpw"""
import getpass

from pwdlib import PasswordHash

password = getpass.getpass("Dashboard-Passwort: ")
if len(password) < 10:
    raise SystemExit("Bitte mindestens 10 Zeichen verwenden.")
if password != getpass.getpass("Wiederholen: "):
    raise SystemExit("Die Eingaben stimmen nicht überein.")
print("\nIn die .env eintragen:\nDASHBOARD_PASSWORD_HASH=" + PasswordHash.recommended().hash(password))
