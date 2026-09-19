"""
30 zones covering Noida, Greater Noida, some Delhi areas, and Gurgaon.
Each zone has lat, lng, and a base winter AQI value for November simulation.

Tiers:
  Hotspots (380-480): severe pollution, unmasked riders blocked
  Poor (280-350): bad air, unmasked riders prefer to avoid
  Moderate (250-300): borderline
  Relatively clean (180-260): acceptable
"""

ZONES = [
    # NOIDA: Hotspots (380-480)
    {"id": "z_sector_62", "name": "Sector 62", "lat": 28.4865, "lng": 77.4123, "base_aqi": 420},
    {"id": "z_sector_18", "name": "Sector 18", "lat": 28.5855, "lng": 77.3697, "base_aqi": 400},
    {"id": "z_sector_15", "name": "Sector 15", "lat": 28.5950, "lng": 77.3600, "base_aqi": 390},
    {"id": "z_sector_135", "name": "Sector 135", "lat": 28.5280, "lng": 77.4450, "base_aqi": 410},
    {"id": "z_bisrakh", "name": "Bisrakh", "lat": 28.4920, "lng": 77.4280, "base_aqi": 440},
    {"id": "z_greater_noida", "name": "Greater Noida", "lat": 28.4720, "lng": 77.5300, "base_aqi": 450},

    # NOIDA/NCR: Poor (280-350)
    {"id": "z_sector_50", "name": "Sector 50", "lat": 28.5745, "lng": 77.3995, "base_aqi": 320},
    {"id": "z_city_center", "name": "Noida City Center", "lat": 28.5897, "lng": 77.3795, "base_aqi": 310},
    {"id": "z_sector_31", "name": "Sector 31", "lat": 28.5682, "lng": 77.3888, "base_aqi": 305},
    {"id": "z_ecotech_extn", "name": "Ecotech Extn", "lat": 28.5850, "lng": 77.4250, "base_aqi": 330},
    {"id": "z_laxmi_nagar", "name": "Laxmi Nagar", "lat": 28.5690, "lng": 77.3070, "base_aqi": 315},

    # NOIDA: Moderate (250-300)
    {"id": "z_tech_park", "name": "Tech Park", "lat": 28.5760, "lng": 77.4015, "base_aqi": 280},
    {"id": "z_sector_144", "name": "Sector 144", "lat": 28.5550, "lng": 77.4350, "base_aqi": 275},
    {"id": "z_golf_course", "name": "Golf Course Road", "lat": 28.5820, "lng": 77.4170, "base_aqi": 285},
    {"id": "z_sector_37", "name": "Sector 37", "lat": 28.5620, "lng": 77.3920, "base_aqi": 270},
    {"id": "z_mayur_vihar", "name": "Mayur Vihar", "lat": 28.5400, "lng": 77.3800, "base_aqi": 290},

    # NOIDA: Relatively clean (180-260)
    {"id": "z_sector_129", "name": "Sector 129", "lat": 28.5350, "lng": 77.4490, "base_aqi": 220},
    {"id": "z_sector_168", "name": "Sector 168", "lat": 28.5180, "lng": 77.4600, "base_aqi": 200},

    # GHAZIABAD: Hotspot
    {"id": "z_ghaziabad", "name": "Ghaziabad", "lat": 28.6690, "lng": 77.4570, "base_aqi": 430},

    # DELHI: Poor to Moderate
    {"id": "z_okhla", "name": "Okhla", "lat": 28.5170, "lng": 77.2550, "base_aqi": 295},
    {"id": "z_ito", "name": "ITO", "lat": 28.6148, "lng": 77.2353, "base_aqi": 340},
    {"id": "z_daryaganj", "name": "Daryaganj", "lat": 28.6455, "lng": 77.2338, "base_aqi": 330},
    {"id": "z_delhi_gate", "name": "Delhi Gate", "lat": 28.6362, "lng": 77.2436, "base_aqi": 325},
    {"id": "z_connaught_place", "name": "Connaught Place", "lat": 28.6328, "lng": 77.1903, "base_aqi": 310},
    {"id": "z_karol_bagh", "name": "Karol Bagh", "lat": 28.6565, "lng": 77.2110, "base_aqi": 320},

    # DELHI: Relatively clean
    {"id": "z_vasant_kunj", "name": "Vasant Kunj", "lat": 28.5244, "lng": 77.1995, "base_aqi": 240},
    {"id": "z_aerocity", "name": "Aerocity", "lat": 28.5715, "lng": 77.0950, "base_aqi": 230},
    {"id": "z_dwarka", "name": "Dwarka", "lat": 28.5921, "lng": 77.0459, "base_aqi": 210},

    # GURGAON: Relatively clean
    {"id": "z_dlf_gurgaon", "name": "DLF Gurgaon", "lat": 28.4545, "lng": 77.0730, "base_aqi": 225},
    {"id": "z_cyber_city", "name": "Cyber City", "lat": 28.4595, "lng": 77.1019, "base_aqi": 235},
]


def get_zones():
    """Return all zones."""
    return ZONES
