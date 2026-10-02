import os

os.environ["DEMO"] = "true"
os.environ["COOKIE_SECURE"] = "false"
os.environ["CHATBOTS"] = ""
os.environ["SESSION_SECRET"] = "t" * 40
os.environ["DASHBOARD_PASSWORD_HASH"] = ""