import unittest

from PIL import Image, ImageDraw

from server import find_plate_label_box, register_cell_box, select_row_boundaries


class RowBoundarySelectionTests(unittest.TestCase):
    def test_selects_plausible_records_and_skips_early_noise(self):
        starts = [130, 220, 315, 395, 485, 580, 680, 775, 875, 975]
        candidates = [(100, 2), *[(position, 3) for position in starts], (1085, 2)]

        geometry = select_row_boundaries(candidates, rows=10, body_top=100, body_bottom=1100)

        self.assertIsNotNone(geometry)
        self.assertNotEqual(geometry["boundaries"][:10], starts)
        for index, center in enumerate(starts):
            self.assertLessEqual(geometry["boundaries"][index], center)
            self.assertGreater(geometry["boundaries"][index + 1], center)
        self.assertGreater(geometry["confidence"], 0)

    def test_rejects_clustered_marks_that_do_not_cover_the_table(self):
        candidates = [(100 + index * 12, 3) for index in range(12)]

        self.assertIsNone(select_row_boundaries(candidates, rows=10, body_top=100, body_bottom=1100))

    def test_rejects_one_implausibly_tall_record(self):
        candidates = [(100, 3), (195, 3), (290, 3), (385, 3), (480, 3),
                      (575, 3), (670, 3), (765, 3), (860, 3), (1090, 3)]

        self.assertIsNone(select_row_boundaries(candidates, rows=10, body_top=100, body_bottom=1100))

    def test_cell_box_expands_outward_instead_of_cutting_strokes(self):
        row_bounds = [124, 203, 299]

        box = register_cell_box(1600, 1131, column=2, row=0, row_bounds=row_bounds)

        self.assertLess(box[0], round(1600 * 0.147))
        self.assertGreater(box[2], round(1600 * 0.292))
        self.assertLess(box[1], row_bounds[0])
        self.assertGreater(box[3], row_bounds[1])

    def test_finds_small_bright_number_tag_inside_dark_photograph(self):
        image = Image.new('RGB', (220, 200), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 180, 165), fill=(35, 35, 35))
        draw.rectangle((84, 140, 119, 157), fill=(245, 245, 235))
        draw.line((91, 145, 110, 152), fill=(25, 25, 25), width=2)

        box = find_plate_label_box(image, [20, 20, 180, 165])

        self.assertIsNotNone(box)
        self.assertLessEqual(box[0], 84)
        self.assertGreaterEqual(box[2], 119)
        self.assertLessEqual(box[1], 140)
        self.assertGreaterEqual(box[3], 157)


if __name__ == "__main__":
    unittest.main()
