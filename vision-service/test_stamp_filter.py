import unittest

import cv2
import numpy as np

from server import looks_like_direct_page_stamp


class DirectPageStampFilterTests(unittest.TestCase):
    def test_rejects_circular_ink_stamp_on_white_page(self):
        page = np.full((500, 700), 248, dtype=np.uint8)
        center = (520, 210)
        cv2.circle(page, center, 72, 45, 4)
        cv2.circle(page, center, 57, 70, 2)
        for angle in range(0, 360, 30):
            radians = np.deg2rad(angle)
            start = (
                round(center[0] + 45 * np.cos(radians)),
                round(center[1] + 45 * np.sin(radians)),
            )
            end = (
                round(center[0] + 62 * np.cos(radians)),
                round(center[1] + 62 * np.sin(radians)),
            )
            cv2.line(page, start, end, 65, 3)

        self.assertTrue(
            looks_like_direct_page_stamp(page, [442, 132, 598, 288])
        )

    def test_keeps_circular_artifact_inside_dark_photo_panel(self):
        page = np.full((500, 700), 248, dtype=np.uint8)
        cv2.rectangle(page, (400, 100), (620, 330), 35, -1)
        cv2.circle(page, (510, 215), 78, 178, -1)
        cv2.circle(page, (510, 215), 68, 80, 4)

        self.assertFalse(
            looks_like_direct_page_stamp(page, [400, 100, 620, 330])
        )

    def test_keeps_rectangular_artifact_panel(self):
        page = np.full((500, 700), 248, dtype=np.uint8)
        cv2.rectangle(page, (420, 90), (590, 340), 65, -1)

        self.assertFalse(
            looks_like_direct_page_stamp(page, [420, 90, 590, 340])
        )


if __name__ == "__main__":
    unittest.main()
